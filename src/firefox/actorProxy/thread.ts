import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequest, PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { SourceActorProxy } from './source';

let log = Log.create('ThreadActorProxy');

export enum ExceptionBreakpoints {
	All, Uncaught, None
}

/**
 * A ThreadActorProxy is a proxy for a "thread-like actor" (a Tab or a WebWorker) in Firefox. 
 */
export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
		log.debug(`Created thread ${this.name}`);
	}

	public get name() {
		return this._name;
	}

	private pendingAttachRequest: PendingRequest<void>;
	private attachPromise: Promise<void>;
	private pendingResumeRequest: PendingRequest<void>;
	private resumePromise: Promise<void>;
	private pendingInterruptRequest: PendingRequest<void>;
	private interruptPromise: Promise<void>;
	private pendingDetachRequest: PendingRequest<void>;
	private detachPromise: Promise<void>;
	
	private pendingSourcesRequests = new PendingRequests<FirefoxDebugProtocol.Source[]>();
	private pendingStackFramesRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	private pendingEvaluateRequests = new PendingRequests<FirefoxDebugProtocol.Grip>();
	private pendingReleaseRequests = new PendingRequests<void>();
	
	/**
	 * Attach the thread if it is detached
	 */
	public attach(): Promise<void> {
		log.debug(`Attaching thread ${this.name}`);
		
		if (!this.attachPromise) {

			this.attachPromise = new Promise<void>((resolve, reject) => {
				this.pendingAttachRequest = { resolve, reject };
				this.connection.sendRequest({ 
					to: this.name, type: 'attach', 
					options: { useSourceMaps: true }
				});
			});
			this.detachPromise = null;
			
		} else {
			log.warn('Attaching this thread has already been requested!');
		}
		
		return this.attachPromise;
	}
	
	/**
	 * Resume the thread if it is paused
	 */
	public resume(exceptionBreakpoints: ExceptionBreakpoints, resumeLimitType?: 'next' | 'step' | 'finish'): Promise<void> {
		log.debug(`Resuming thread ${this.name}`);
		
		if (!this.resumePromise) {

			let resumeLimit = resumeLimitType ? { type: resumeLimitType } : undefined;
			let pauseOnExceptions = undefined;
			let ignoreCaughtExceptions = undefined;
			switch (exceptionBreakpoints) {
				case ExceptionBreakpoints.All:
					pauseOnExceptions = true;
					break;
					
				case ExceptionBreakpoints.Uncaught:
					pauseOnExceptions = true;
					ignoreCaughtExceptions = true;
					break;
			}
			
			this.resumePromise = new Promise<void>((resolve, reject) => {
				this.pendingResumeRequest = { resolve, reject };
				this.connection.sendRequest({ 
					to: this.name, type: 'resume', 
					resumeLimit, pauseOnExceptions, ignoreCaughtExceptions
				});
			});
			this.interruptPromise = null;
			
		}
		
		return this.resumePromise;
	}
	
	/**
	 * Interrupt the thread if it is running
	 */
	public interrupt(): Promise<void> {
		log.debug(`Interrupting thread ${this.name}`);
		
		if (!this.interruptPromise) {

			this.interruptPromise = new Promise<void>((resolve, reject) => {
				this.pendingInterruptRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'interrupt' });
			});
			this.resumePromise = null;
			
		}
		
		return this.interruptPromise;
	}
	
	/**
	 * Detach the thread if it is attached
	 */
	public detach(): Promise<void> {
		log.debug(`Detaching thread ${this.name}`);
		
		if (!this.detachPromise) {

			this.detachPromise = new Promise<void>((resolve, reject) => {
				this.pendingDetachRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'detach' });
			});
			this.attachPromise = null;
			
		} else {
			log.warn('Detaching this thread has already been requested!');
		}
		
		return this.detachPromise;
	}

	/**
	 * Fetch the list of source files. This will also cause newSource events to be emitted for
	 * every source file (including those that are loaded later and strings passed to eval())
	 */
	public fetchSources(): Promise<FirefoxDebugProtocol.Source[]> {
		log.debug(`Fetching sources from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Source[]>((resolve, reject) => {
			this.pendingSourcesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}

	/**
	 * Fetch StackFrames. This can only be called while the thread is paused.
	 */
	public fetchStackFrames(levels: number): Promise<FirefoxDebugProtocol.Frame[]> {
		log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingStackFramesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'frames', 
				start: 0, count: levels
			});
		});
	}
	
	/**
	 * Evaluate the given expression on the specified StackFrame. This can only be called while
	 * the thread is paused and will resume it temporarily.
	 */
	public evaluate(expr: string, frameActorName: string): Promise<FirefoxDebugProtocol.Grip> {
		log.debug(`Evaluating '${expr}' on thread ${this.name}`);
		
		return new Promise<FirefoxDebugProtocol.Grip>((resolve, reject) => {
			this.pendingEvaluateRequests.enqueue({ resolve, reject });
			let escapedExpression = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			let tryExpression = `eval("try{${escapedExpression}}catch(e){e.name+':'+e.message}")`;
			this.connection.sendRequest({ 
				to: this.name, type: 'clientEvaluate', 
				expression: tryExpression, frame: frameActorName 
			});
		});
	}

	/**
	 * Release object grips that were promoted to thread-lifetime grips using 
	 * ObjectGripActorProxy.extendLifetime(). This can only be called while the thread is paused.
	 */
	public releaseMany(objectGripActorNames: string[]): Promise<void> {
		log.debug(`Releasing grips on thread ${this.name}`);
		
		return new Promise<void>((resolve, reject) => {
			this.pendingReleaseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ 
				to: this.name, type: 'releaseMany',
				actors: objectGripActorNames 
			});
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			log.debug(`Received paused message of type ${pausedResponse.why.type}`);
			
			switch (pausedResponse.why.type) {
				case 'attached':
					if (this.pendingAttachRequest) {
						this.pendingAttachRequest.resolve(undefined);
						this.pendingAttachRequest = null;
						this.interruptPromise = Promise.resolve(undefined);
					} else {
						log.warn('Received attached message without pending request');
					}
					break;

				case 'interrupted':
					if (this.pendingInterruptRequest) {
						this.pendingInterruptRequest.resolve(undefined);
						this.pendingInterruptRequest = null;
					} else {
						log.warn('Received interrupted message without pending request');
					}
					break;
					
				case 'resumeLimit':
				case 'breakpoint':
				case 'exception':
					this.interruptPromise = Promise.resolve(undefined);
					this.resumePromise = null;
					this.pendingInterruptRequest = null;
					this.pendingResumeRequest = null;
					this.emit('paused', pausedResponse.why);
					break;
					
				case 'clientEvaluated':
					this.interruptPromise = Promise.resolve(undefined);
					this.resumePromise = null;
					this.pendingEvaluateRequests.resolveOne(pausedResponse.why.frameFinished.return);
					break;

				default:
					log.warn(`Paused event with reason ${pausedResponse.why.type} not handled yet`);
					this.emit('paused', pausedResponse.why);
					break;
			}

		} else if (response['type'] === 'resumed') {

			log.debug(`Received resumed event from ${this.name}`);
			if (this.pendingResumeRequest) {
				this.pendingResumeRequest.resolve(undefined);
				this.pendingResumeRequest = null;
			} else {
				log.warn('Received resumed reply without pending request');
			}
			
		} else if (response['type'] === 'detached') {
			
			log.debug(`Thread ${this.name} detached`);
			if (this.pendingDetachRequest) {
				this.pendingDetachRequest.resolve(undefined);
				this.pendingDetachRequest = null;
			} else {
				log.warn(`Thread ${this.name} detached without a corresponding request`);
			}

			this.pendingStackFramesRequests.rejectAll('Detached');
			this.pendingEvaluateRequests.rejectAll('Detached');
			
		} else if (response['sources']) {

			let sources = <FirefoxDebugProtocol.Source[]>(response['sources']);
			log.debug(`Received ${sources.length} sources from thread ${this.name}`);
			this.pendingSourcesRequests.resolveOne(sources);

		} else if (response['type'] === 'newSource') {
			
			let source = <FirefoxDebugProtocol.Source>(response['source']);
			log.debug(`New source ${source.url} on thread ${this.name}`);
			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);
			log.debug(`Received ${frames.length} frames from thread ${this.name}`);
			this.pendingStackFramesRequests.resolveOne(frames);
			
		} else if (response['type'] === 'exited') {
			
			log.debug(`Thread ${this.name} exited`);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {

			log.warn(`Thread ${this.name} was in the wrong state for the last request`);
			//TODO reject last request!
			this.emit('wrongState');
			
		} else if (Object.keys(response).length === 1) {

			log.debug('Received response to releaseMany request');
			this.pendingReleaseRequests.resolveOne(undefined);

		} else {

			if (response['type'] === 'newGlobal') {
				log.debug(`Received newGlobal event from ${this.name} (ignoring)`);
			} else {
				log.warn("Unknown message from ThreadActor: " + JSON.stringify(response));
			}			

		}
			
	}

	/**
	 * The paused event is sent when the thread is paused because it hit a breakpoint or a
	 * resumeLimit, but not if it was paused due to an interrupt request or because an evaluate
	 * request is finished
	 */	
	public onPaused(cb: (reason: FirefoxDebugProtocol.ThreadPausedReason) => void) {
		this.on('paused', cb);
	}

	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onNewSource(cb: (newSource: SourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}
