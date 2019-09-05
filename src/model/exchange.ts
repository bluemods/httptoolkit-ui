import * as _ from 'lodash';
import { observable, computed, flow } from 'mobx';

import {
    HtkRequest,
    HtkResponse,
    Headers,
    MessageBody,
    InputInitiatedRequest,
    InputRequest,
    InputResponse,
    TimingEvents,
    InputMessage,
    MockttpBreakpointedRequest,
    MockttpBreakpointedResponse,
    BreakpointRequestResult,
    BreakpointResponseResult
} from "../types";
import {
    lazyObservablePromise,
    ObservablePromise,
    fakeBuffer,
    FakeBuffer,
    asHeaderArray,
    getDeferred,
    Deferred
} from '../util';

import { parseSource } from './sources';
import { getContentType } from './content-types';
import { getExchangeCategory, ExchangeCategory } from './exchange-colors';

import { getMatchingAPI, ApiExchange } from './openapi/openapi';
import { ApiMetadata } from './openapi/build-api';
import { decodeBody, encodeBody } from '../services/ui-worker-api';
import { reportError } from '../errors';
import { getStatusMessage } from './http-docs';

export { TimingEvents };

function addRequestMetadata(request: InputRequest): HtkRequest {
    try {
        const parsedUrl = new URL(request.url, `${request.protocol}://${request.hostname}`);

        return Object.assign(request, {
            parsedUrl,
            source: parseSource(request.headers['user-agent']),
            body: new ExchangeBody(request, request.headers),
            contentType: getContentType(request.headers['content-type']) || 'text',
            cache: observable.map(new Map<symbol, unknown>(), { deep: false })
        }) as HtkRequest;
    } catch (e) {
        console.log(`Failed to parse request for ${request.url} (${request.protocol}://${request.hostname})`);
        throw e;
    }
}

function addResponseMetadata(response: InputResponse): HtkResponse {
    return Object.assign(response, {
        body: new ExchangeBody(response, response.headers),
        contentType: getContentType(response.headers['content-type']) || 'text',
        cache: observable.map(new Map<symbol, unknown>(), { deep: false })
    }) as HtkResponse;
}

export class ExchangeBody implements MessageBody {

    constructor(
        message: InputMessage,
        headers: Headers
    ) {
        if (!('body' in message) || !message.body) {
            this._encoded = Buffer.from("");
        } else if ('buffer' in message.body) {
            this._encoded = message.body.buffer;
        } else {
            this._encoded = fakeBuffer(message.body.encodedLength);
            this._decoded = message.body.decoded;
        }

        this._contentEncoding = asHeaderArray(headers['content-encoding']);
    }

    private _contentEncoding: string[];
    private _encoded: FakeBuffer | Buffer;
    get encoded() {
        return this._encoded;
    }

    private _decoded: Buffer | undefined;

    decodedPromise: ObservablePromise<Buffer | undefined> = lazyObservablePromise(async () => {
        // Exactly one of _encoded & _decoded is a buffer, never neither/both.
        if (this._decoded) return this._decoded;
        const encodedBuffer = this.encoded as Buffer;

        // Temporarily change to a fake buffer, while the web worker takes the data to decode
        const encodedLength = encodedBuffer.byteLength;
        this._encoded = fakeBuffer(encodedLength);

        try {
            const { decoded, encoded } = await decodeBody(encodedBuffer, this._contentEncoding);
            this._encoded = encoded;
            return decoded;
        } catch {
            return undefined;
        }
    });
    get decoded() {
        // We exclude 'Error' from the value - errors should always become undefined
        return this.decodedPromise.value as Buffer | undefined;
    }
}

export type CompletedRequest = Omit<HttpExchange, 'request'> & {
    matchedRuleId: string
};
export type CompletedExchange = Omit<HttpExchange, 'response'> & {
    response: HtkResponse | 'aborted'
};
export type SuccessfulExchange = Omit<HttpExchange, 'response'> & {
    response: HtkResponse
};

export class HttpExchange {

    constructor(request: InputRequest) {
        this.request = addRequestMetadata(request);
        this.timingEvents = request.timingEvents;

        this.id = this.request.id;
        this.matchedRuleId = this.request.matchedRuleId;
        this.searchIndex = [
                this.request.parsedUrl.protocol + '//' +
                this.request.parsedUrl.hostname +
                this.request.parsedUrl.pathname +
                this.request.parsedUrl.search
        ]
        .concat(..._.map(this.request.headers, (value, key) => `${key}: ${value}`))
        .concat(this.request.method)
        .join('\n')
        .toLowerCase();

        this.category = getExchangeCategory(this);

        // Start loading the relevant Open API specs for this request, if any.
        this._apiMetadataPromise = getMatchingAPI(this.request);
    }

    // Logic elsewhere can put values into these caches to cache calculations
    // about this exchange weakly, so they GC with the exchange.
    // Keyed by symbols only, so we know we never have conflicts.
    public cache = observable.map(new Map<symbol, unknown>(), { deep: false });

    public readonly request: HtkRequest;
    public readonly id: string;
    public readonly matchedRuleId: string | undefined; // Undefined initially, defined for completed requests

    isCompletedRequest(): this is CompletedRequest {
        return !!this.matchedRuleId;
    }

    isCompletedExchange(): this is CompletedExchange {
        return !!this.response;
    }

    isSuccessfulExchange(): this is SuccessfulExchange {
        return this.isCompletedExchange() && this.response !== 'aborted';
    }

    @observable
    public readonly timingEvents: TimingEvents | {};  // May be {} if using an old server (<0.1.7)

    @observable.ref
    public response: HtkResponse | 'aborted' | undefined;

    @observable
    public searchIndex: string;

    @observable
    public category: ExchangeCategory;

    markAborted(request: InputInitiatedRequest) {
        this.response = 'aborted';
        this.searchIndex += '\naborted';
        Object.assign(this.timingEvents, request.timingEvents);

        if (this.requestBreakpoint) {
            this.requestBreakpoint.deferred.reject(
                new Error('Request aborted whilst breakpointed at request')
            );
            this.requestBreakpoint = undefined;
        }
        if (this.responseBreakpoint) {
            this.responseBreakpoint.deferred.reject(
                new Error('Request aborted whilst breakpointed at response')
            );
            this.responseBreakpoint = undefined;
        }
    }

    setResponse(response: InputResponse) {
        this.response = addResponseMetadata(response);
        Object.assign(this.timingEvents, response.timingEvents);

        this.category = getExchangeCategory(this);
        this.searchIndex = [
            this.searchIndex,
            response.statusCode.toString(),
            response.statusMessage.toString(),
            ..._.map(response.headers, (value, key) => `${key}: ${value}`)
        ].join('\n').toLowerCase();

        // Wrap the API promise to also add this response data (but lazily)
        const requestApiPromise = this._apiPromise;
        this._apiPromise = lazyObservablePromise(() =>
            requestApiPromise.then((api) => {
                if (api) api.updateWithResponse(this.response!);
                return api;
            })
        );
    }

    // API metadata:

    // A convenient reference to the service-wide spec for this API - starts loading immediately
    private _apiMetadataPromise: Promise<ApiMetadata> | undefined;

    // Parsed API info for this specific request, loaded & parsed lazily, only if it's used
    @observable.ref
    private _apiPromise = lazyObservablePromise(async () => {
        const apiMetadata = await this._apiMetadataPromise;

        if (apiMetadata) {
            return new ApiExchange(apiMetadata, this);
        } else {
            return undefined;
        }
    });

    // Fixed value for the parsed API data - returns the data or undefined, observably.
    get api() {
        if (this._apiPromise.state === 'fulfilled') {
            return this._apiPromise.value as ApiExchange | undefined;
        }
    }

    // Breakpoint data:

    @observable.shallow
    requestBreakpoint?: {
        readonly deferred: Deferred<BreakpointRequestResult>;
        inProgressResult: BreakpointRequestResult;
    };

    @observable.shallow
    responseBreakpoint?: {
        readonly deferred: Deferred<BreakpointResponseResult>;
        readonly responseData: MockttpBreakpointedResponse;
        inProgressResult: BreakpointResponseResult;
    };

    @computed
    get isBreakpointed() {
        return this.requestBreakpoint || this.responseBreakpoint;
    }

    resumeRequestFromBreakpoint = flow(function * (this: HttpExchange) {
        const { inProgressResult } = this.requestBreakpoint!;

        let body = inProgressResult.body;

        if (body) {
            // Encode the body according to the content-encoding specified:
            const encodings = asHeaderArray(inProgressResult.headers['content-encoding']);
            body = (
                yield encodeBody(body, encodings).catch((e) => {
                    reportError(e, { encodings });
                    return { encoded: 'HTTP TOOLKIT ERROR: COULD NOT ENCODE BODY' };
                })
            ).encoded;
        }

        this.requestBreakpoint!.deferred.resolve(
            Object.assign({}, inProgressResult, { body })
        );
        this.requestBreakpoint = undefined;
    });

    resumeResponseFromBreakpoint = flow(function * (this: HttpExchange) {
        const { inProgressResult } = this.responseBreakpoint!;

        let body = inProgressResult.body;

        if (body) {
            // Encode the body according to the content-encoding specified:
            const encodings = asHeaderArray(inProgressResult.headers['content-encoding']);
            body = (
                yield encodeBody(body, encodings).catch((e) => {
                    reportError(e, { encodings });
                    return { encoded: 'HTTP TOOLKIT ERROR: COULD NOT ENCODE BODY' };
                })
            ).encoded;
        }

        this.responseBreakpoint!.deferred.resolve(
            Object.assign({}, inProgressResult, { body })
        );
        this.responseBreakpoint = undefined;
    });

    triggerRequestBreakpoint = flow(function * (
        this: HttpExchange,
        request: MockttpBreakpointedRequest
    ) {
        this.requestBreakpoint = {
            deferred: getDeferred(),
            inProgressResult: {
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: (
                    yield decodeBody(
                        request.body.buffer,
                        asHeaderArray(request.headers['content-encoding'])
                    ).catch((e) => {
                        reportError(e);
                        return { decoded: undefined };
                    })
                ).decoded
            }
        };

        return this.requestBreakpoint.deferred.promise;
    });

    triggerResponseBreakpoint = flow(function * (
        this: HttpExchange,
        response: MockttpBreakpointedResponse
    ) {
        const expectedStatusMessage = getStatusMessage(response.statusCode)
        const statusMessage = expectedStatusMessage === response.statusMessage
            ? undefined
            : response.statusMessage;

        this.responseBreakpoint = {
            deferred: getDeferred(),
            inProgressResult: {
                statusCode: response.statusCode,
                statusMessage: statusMessage,
                headers: response.headers,
                body: (
                    yield decodeBody(
                        response.body.buffer,
                        asHeaderArray(response.headers['content-encoding'])
                    ).catch((e) => {
                        reportError(e);
                        return { decoded: undefined };
                    })
                ).decoded
            },
            responseData: response
        };

        return this.responseBreakpoint.deferred.promise;
    });

}