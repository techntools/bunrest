import { Server } from "bun";
import { BunResponse } from "./response";
import { RequestMethod, Handler, Middleware, BunRequest } from "./request";
import { Router } from "../router/router";
import { Chain } from "../utils/chain";
import { TrieLeaf, TrieTree } from "./node";

export function Server() {
    return BunServer.instance;
}

class BunServer implements RequestMethod {
    // singleton bun server
    private static server?: BunServer;

    constructor() {
        if (BunServer.server) {
            throw new Error('DONT use this constructor to create bun server, try Server()');
        }
        BunServer.server = this;
    }

    static get instance() {
        return BunServer.server ?? (BunServer.server = new BunServer());
    }

    private readonly requestMap: TrieTree<string, Handler> = new TrieTree();
    private readonly middlewares: Middleware[] = [];
    private readonly errorHandlers: Handler[] = [];

    get(path: string, ...handlers: Handler[]) {
        this.delegate(path, "GET", handlers);
    }

    put(path: string, ...handlers: Handler[]) {
        this.delegate(path, "PUT", handlers);
    }

    post(path: string, ...handlers: Handler[]) {
        this.delegate(path, "POST", handlers);
    }

    delete(path: string, ...handlers: Handler[]) {
        this.delegate(path, "DELETE", handlers);
    }

    options(path: string, ...handlers: Handler[]) {
        this.delegate(path, "OPTIONS", handlers);
    }

    /**
     * Add middleware
     * @param middleware 
     */
    use(middleware: Handler): void;

    /**
     * Attach router
     * @param path 
     * @param router 
     */
    use(path: string, router: Router): void;

    /**
     * Attch middleware or router or global error handler
     * @param arg1 
     * @param arg2 
     */
    use(arg1: string | Handler, arg2?: Router) {
        // pass router
        if (arg2 && typeof arg1 === "string") {
            arg2.attach(arg1);
        }

        // pass middleware or global error handler
        else {
            if (arg1.length === 3) {
                this.middlewares.push({
                    path: "/",
                    middlewareFunc: arg1 as Handler,
                });
            }

            else if (arg1.length === 4) {
                this.errorHandlers.push(arg1 as Handler);
            }
        }
    }

    router() {
        return new Router(this.requestMap, this.middlewares);
    }

    listen(port: string | number, callback?: () => void): Server {
        const baseUrl = "http://localhost:" + port;
        callback?.call(null);
        return this.openServer(port, baseUrl);
    }

    private openServer(port: string | number, baseUrl: string): Server {
        const that = this;
        return Bun.serve({
            port,
            development: process.env.SERVER_ENV !== "production",
            async fetch(req1: Request) {
                const req: BunRequest = await that.bunRequest(req1);

                const res = that.responseProxy();
                const leaf: TrieLeaf<string, Handler> = that.requestMap.get(`${req.method}-${req.path}`);
                const handler: Handler = leaf.node?.getValue();

                // append req route params
                req.params = leaf.routeParams;

                if (that.middlewares.length !== 0) {
                    const plainMid = that.middlewares.filter((mid) => (mid.path === '/'));
                    const chain = new Chain(req, res, plainMid);
                    chain.next();

                    if (res.isReady()) {
                        return res.getResponse();
                    }

                    if (!chain.isFinish()) {
                        throw new Error('Please call next() at the end of your middleware');
                    }
                }

                const middlewares = [];
                for (let i = that.middlewares.length - 1; i >= 0; --i) {
                    const target = that.middlewares[i];
                    if (target.path === '/') {
                        continue;
                    }

                    if (target.path === `${req.method}-${req.path}`) {
                        middlewares.push(target);
                        break;
                    }
                }

                if (middlewares.length !== 0) {
                    const chain = new Chain(req, res, middlewares);
                    chain.next();

                    if (res.isReady()) {
                        return res.getResponse();
                    }

                    if (!chain.isFinish()) {
                        throw new Error('Please call next() at the end of your middleware');
                    }
                }

                if (handler) {
                    handler.apply(that, [req, res]);
                }

                return res.getResponse();
            },
            error(err: Error) {
                const res = that.responseProxy();
                // basically, next here is to ignore the error
                const next = () => { }
                that.errorHandlers.forEach((handler) => {
                    // * no request object pass to error handler 
                    handler.apply(that, [null, res, err, next]);
                });

                if (res.isReady()) {
                    return res.getResponse();
                }

                throw err;
            }
        });
    }

    private async bunRequest(req: Request): Promise<BunRequest> {
        const { searchParams, pathname } = new URL(req.url);

        const newReq: BunRequest = {
            method: req.method,
            path: pathname,
            request: req,
            query: {},
            params: {}
        };

        // append query params
        searchParams.forEach((v, k) => {
            newReq.query[k] = v;
        });

        // append body
        const body = await req.json;
        newReq.body = body;
        newReq.bodys = req.blob;

        return newReq;
    }

    private responseProxy(): BunResponse {
        const bunResponse = new BunResponse();
        return new Proxy(bunResponse, {
            get(target, prop, receiver) {
                if (typeof target[prop] === 'function'
                    && (prop === 'json' || prop === 'send')
                    && target.isReady()) {
                    throw new Error('You cannot send response twice');
                } else {
                    return Reflect.get(target, prop, receiver);
                }
            }
        });
    }

    private delegate(path: string, method: string, handlers: Handler[]) {
        const key = `${method}-${path}`;
        for (let i = 0; i < handlers.length; ++i) {
            const handler = handlers[i];
            if (i == handlers.length - 1) {
                this.requestMap.insert(key, handler);
                break;
            }

            this.middlewares.push({
                path: key,
                middlewareFunc: handler,
            });            
        }
    }
}