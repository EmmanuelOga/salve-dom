/**
 * Main module of salve-dom.
 * @author Louis-Dominique Dubeau
 * @license MPL 2.0
 * @copyright Mangalam Research Center for Buddhist Languages
 */
import { BasePattern, EName, Event, EventSet, Grammar, GrammarWalker,
         ValidationError, Walker } from "salve";
import { Consuming, EventEmitter } from "./event_emitter";
import { fixPrototype } from "./tools";

function _indexOf(parent: NodeList, needle: Node): number {
  return Array.prototype.indexOf.call(parent, needle);
}

export function isAttr(it: Node): it is Attr {
  const attrNodeType = Node.ATTRIBUTE_NODE;
  // We check that ``attr_node_type`` is not undefined because eventually
  // ``ATTRIBUTE_NODE`` will be removed from the ``Node`` interface, and then we
  // could be testing ``undefined === undefined`` for objects which are not
  // attributes, which would return ``true``. The function is not very strict
  // but it should not be too lax either.
  return it instanceof Attr ||
    ((attrNodeType !== undefined) && (it.nodeType === attrNodeType));
}

// validation_stage values

enum Stage {
  START_TAG = 1,
  CONTENTS,
  END_TAG,
}

// Working state values

export enum WorkingState {
  /**
   * The validator is stopped but has not completed a validation pass yet.
   */
  INCOMPLETE = 1,
  /**
   * The validator is working on validating the document.
   */
  WORKING,
  /**
   * The validator is stopped and has found the document invalid. Note that this
   * state happens *only* if the whole document was validated.
   */
  INVALID,
  /**
   * The validator is stopped and has found the document valid. Note that this
   * state happens *only* if the whole document was validated.
   */
  VALID,
}

/**
 * Data structure for recording progress.
 *
 * @private
 *
 * @param partDone The part of the document done so far.
 *
 * @param portion A ProgressState object is created in relation to an
 * element. The element covers portion X of the total document. This parameter
 * should be X.
 */
class ProgressState {
  constructor(public partDone: number,
              public portion: number) {}
}

//
// Note: the Validator class adds information to the Element nodes it
// is working with by adding expando properties that start with
// "wed_event_". This deemed acceptable here because:
//
// * The tree on which a Validator object operates is not supposed to
//   be open to third party software. Even if it were, the chance of a
//   clash is small.
//
// * The values of the expando properties are primitives (not objects
//   or other elements).
//
// * We don't care about browsers or situations where expando
//   properties are not supported.
//

//
// These are constants. So create them once rather than over and over
// again.
//
const ENTER_CONTEXT_EVENT = new Event("enterContext");
const LEAVE_START_TAG_EVENT = new Event("leaveStartTag");
const LEAVE_CONTEXT_EVENT = new Event("leaveContext");

/**
 * Exception to be raised if we can't find our place in the events list. It is
 * only to be raised by code in this module but the documentation is left public
 * for diagnosis purposes.
 */
class EventIndexException extends Error {
  constructor() {
    super(
      "undefined event_index; _validateUpTo should have taken care of that");
    fixPrototype(this, EventIndexException);
  }
}

// This private utility function checks whether an event is possible
// only because there is a name_pattern wildcard that allows it.
function isPossibleDueToWildcard(walker: Walker<BasePattern>,
                                 eventName: string,
                                 ns: string,
                                 name: string): boolean {
  const evs = walker.possible().toArray();
  let matched = false;
  for (const ev of evs) {
    if (ev.params[0] !== eventName) {
      continue;
    }
    const namePattern = ev.params[1];
    const matches = namePattern.match(ns, name);

    // Keep track of whether it ever matched anything.
    matched = matched || matches;

    // We already know that it matches, and this is not merely due
    // to a wildcard.
    if (matches && !namePattern.wildcardMatch(ns, name)) {
      return false;
    }
  }

  // If it never matched any pattern at all, then we must return false.  If we
  // get here and matched is true then it means that it matched all patterns due
  // to wildcards.
  return matched;
}

export interface ErrorData {
  error: ValidationError;
  node?: Node | null;
  index?: number;
}

export interface ResetData {
  at: number;
}

export interface WorkingStateData {
  state: WorkingState;
  partDone: number;
}

declare global {
  //
  // Blegh... the global environment that TypeScript defines is based on IE
  // poop. This code requires the following to be true. Users must load a shim to
  // ensure it in crap browsers like IE.
  //
  // tslint:disable-next-line: no-empty-interfaces
  interface Text extends ElementTraversal {}
}

/**
 * A mapping of event name to event type for the events that [[Validator]]
 * supports. This is used by TypeScript's generics but it is also a nice handy
 * reference.
 */
export interface Events {
  "error": ErrorData;
  "reset-errors": ResetData;
  "state-update": WorkingStateData;
  "possible-due-to-wildcard-change": Node;
  "*": any;
}

export interface CustomNodeProperties {
  "EventIndexAfter": number;
  "EventIndexAfterStart": number;
  "EventIndexBeforeAttributes": number;
  "EventIndexAfterAttributes": number;
  "PossibleDueToWildcard": boolean;
}

export type CustomNodeProperty = keyof CustomNodeProperties;

/**
 * The options accepted by the validator.
 */
export interface Options {
  /**
   * A prefix string to use in front of the expando properties set by the
   * validator.
   */
  prefix?: string;

  /**
   * The timeout between one cycle and the next. This is the number of
   * milliseconds that elapse before the next cycle runs.
   */
  timeout?: number;

  /**
   * The maximum number of milliseconds a cycle may run. A cycle will stop after
   * it has used the number of milliseconds listed here. Setting this to 0 means
   * "run until done" which is not generally recommended.
   */
  maxTimespan?: number;

  /**
   * The distance between walkers under which we skip saving a walker in the
   * cache. This is a setting you should probably not mess with unless you know
   * what you are doing.
   */
  walkerCacheGap?: number;
}

/**
 * A document validator. The validator assumes that the DOM tree it uses for
 * validation is always normalized: that is, there are no empty text nodes and
 * there cannot be two adjacent text nodes.
 *
 * This validator operates by scheduling work cycles. Given the way JavaScript
 * works, if the validator just validated the whole document in one shot, it
 * would take all processing power until done, and everything else would
 * block. Rather than do this, it performs a bit of work, stops, and performs
 * another bit, etc. Each bit of work is called a "cycle". The options passed to
 * the validator at creation determine how long a cycle may last and how much
 * time elapses between cycles. (Yes, using ``Worker``s has been considered as
 * an option but it would complicate the whole deal by quite a bit due to
 * communication costs between a ``Worker`` and the main process.)
 *
 * @param schema A ``Grammar`` object that has already been produced from
 * ``salve``'s ``constructTree``.
 *
 * @param root The root of the DOM tree to validate. This root contains the
 * document to validate but is not part of the document itself.
 *
 * @param options Some options driving how the validator works.
 */
export class Validator {
  private _cycleEntered: number = 0;
  private _timeout: number = 200;
  private _maxTimespan: number = 100;
  private _timeoutId: number | undefined;
  private _restarting: boolean = false;
  private _errors: ErrorData[] = [];
  private readonly _boundWrapper: Function = this._workWrapper.bind(this);

  // Validation state
  private _validationEvents: Event[] = [];
  private _validationWalker: GrammarWalker;
  private _workingState: WorkingState = WorkingState.INCOMPLETE;
  private _partDone: number = 0;
  private _validationStage: Stage = Stage.CONTENTS;
  private _previousChild: Node | null = null;
  private _validationStack: ProgressState[] = [new ProgressState(0, 1)];
  private _curEl: Element | Document;
  private _walkerCache: {[key: number]: GrammarWalker} = Object.create(null);
  private _walkerCacheMax: number = -1;
  private readonly _prefix: string = "salveDom";
  // The distance between walkers under which we skip saving a
  // walker in the cache.
  private _walkerCacheGap: number = 100;
  private readonly _events: EventEmitter<Events> = new EventEmitter<Events>();
  public readonly events: Consuming<Events>;

  constructor(private readonly schema: Grammar,
              private readonly root: Element | Document,
              options: Options = {}) {

    const keys: (keyof Options)[] = ["timeout", "maxTimespan", "walkerCacheGap"];
    for (const key of keys) {
      const value = options[key];
      if (value === undefined) {
        continue;
      }

      if (value < 0) {
        throw new Error(`the value for ${key} cannot be negative`);
      }

      (this as any)["_" + key] = options[key];
    }

    if (options.prefix) {
      this._prefix = options.prefix;
    }

    this._curEl = this.root;
    // This prevents an infinite loop when speculativelyValidate is
    // called to validate a text node.
    this._setNodeProperty(this._curEl, "EventIndexAfterStart",
                          this._validationEvents.length);
    this._setWorkingState(WorkingState.INCOMPLETE, 0);
    this._validationWalker = this.schema.newWalker();
    this.events = this._events;
  }

  private makeKey(key: CustomNodeProperty): string {
    return `${this._prefix}${key}`;
  }

  /**
   * Function allowing to get a custom properties set on [[Node]] objects by
   * this class.
   */
  getNodeProperty<T extends CustomNodeProperty>(
    node: Node,
    key: T): CustomNodeProperties[T] | undefined {
      return (node as any)[this.makeKey(key)] as CustomNodeProperties[T];
    }

  /**
   * Function allowing to set a custom properties set on [[Node]] objects by
   * this class.
   */
  private _setNodeProperty<T extends CustomNodeProperty>(
    node: Node,
    key: T,
    value: CustomNodeProperties[T]): void {
    (node as any)[this.makeKey(key)] = value;
  }

  private _clearNodeProperties(node: Node): void {
    const keys: CustomNodeProperty[] = [
      "EventIndexAfter",
      "EventIndexAfterStart",
      "EventIndexBeforeAttributes",
      "EventIndexAfterAttributes",
      "PossibleDueToWildcard",
    ];
    for (const key of keys) {
      delete (node as any)[this.makeKey(key)];
    }
  }

  /**
   * Starts the background validation process.
   */
  start(): void {
    if (this._timeoutId !== undefined) {
      this._stop(WorkingState.WORKING);
    }

    // When we call ``this.start``, we want the validation to start ASAP. So we
    // do not use ``this._timeout`` here. However, we do not call
    // ``this._workWrapper`` directly because we want to be able to call
    // ``this.start`` from event handlers. If we did call ``this._workWrapper``
    // directly, we'd be calling this._cycle from inside this._cycle, which is
    // results in an internal error.
    this._timeoutId = setTimeout(this._boundWrapper, 0);
  }

  /**
   * Get the namespaces defined in the schema passed to the
   * Validator.
   *
   * @returns The namespaces known to the schema.
   */
  getSchemaNamespaces(): string[] {
    return this.schema.getNamespaces();
  }

  /**
   * Get the namespaces used in the document. This method does not cache its
   * information and scan the whole document independently of the current
   * validation status. It is okay to call it on an uninitialized Validator
   * because it does not use the regular validation machinery.
   *
   * @returns An object whose keys are namespace prefixes and values are lists
   * of namespace URIs.  The values are lists because prefixes can be redefined
   * in a document.
   */
  getDocumentNamespaces(): {[key: string]: string[]} {
    const ret: {[key: string]: string[]} = {};

    function _process(node: Node | null): void {
      if (!node) {
        return;
      }

      const attrIxLim = node.attributes.length;
      for (let attrIx = 0; attrIx < attrIxLim; ++attrIx) {
        const attr = node.attributes[attrIx];
        if (attr.name.lastIndexOf("xmlns", 0) === 0) {
          const key = attr.name.slice(6);
          let array = ret[key];
          if (!array) {
            array = ret[key] = [];
          }
          array.push(attr.value);
        }
      }

      let child = node.firstChild;
      while (child) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          _process(child);
        }
        child = child.nextSibling;
      }
    }

    _process(this.root.firstChild);
    return ret;
  }

  /**
   * Convenience method. The bound version of this method
   * (``this._boundWrapper``) is what is called by the timeouts to perform the
   * background validation.
   */
  private _workWrapper(): void {
    if (this._work()) {
      this._timeoutId = setTimeout(this._boundWrapper, this._timeout);
    }
  }

  /**
   * Controller method for the background validation. Keeps the validator
   * running only until done or until the maximum time span for one run
   * of the validator is reached.
   *
   * @returns False if there is no more work to do. True otherwise.
   */
  private _work(): boolean {
    const startDate = Date.now();
    while (true) { // tslint:disable-line: no-constant-condition
      // Give a chance to other operations to work.
      if ((this._maxTimespan > 0) &&
          (Date.now() - startDate) >= this._maxTimespan) {
        return true;
      }

      const ret = this._cycle();
      if (!ret) {
        return false;
      }
    }
  }

  /**
   * Performs one cycle of validation. "One cycle" is an arbitrarily
   * small unit of work.
   *
   * @returns False if there is no more work to be done. True otherwise.
   *
   * @throws {Error} When there is an internal error.
   */
  // tslint:disable-next-line: max-func-body-length
  private _cycle(): boolean {
    // If we got here after a restart, then we've finished restarting.  If we
    // were not restarting, then this is a noop.
    this._restarting = false;

    //
    // This check is meant to catch problems that could be hard to diagnose if
    // wed or one of its modes had a bug such that `_cycle` is reentered from
    // `_cycle`. This could happen during error processing, for instance. Error
    // processing causes wed to process the errors, which causes changes in the
    // GUI tree, which *could* (this would be a bug) cause the code of a mode to
    // execute something like `getErrorsFor`, which could cause `_cycle` to be
    // reentered.
    //
    if (this._cycleEntered > 0) {
      throw new Error("internal error: _cycle is being reentered");
    }

    if (this._cycleEntered < 0) {
      throw new Error("internal error: _cycleEntered negative");
    }

    //
    // IMPORTANT: This variable must be decremented before exiting this
    // method. A try...finally statement is not used here because it would
    // prevent some virtual machines from optimizing this function.
    //
    this._cycleEntered++;

    const walker = this._validationWalker;
    const stack = this._validationStack;
    const events = this._validationEvents;
    let portion = stack[0].portion;
    let stage = this._validationStage;

    stage_change:
    while (true) { // tslint:disable-line: no-constant-condition
      let curEl = this._curEl;
      switch (stage) {
      case Stage.START_TAG: {
        // The logic is such that if we get here curEl must be an Element.
        curEl = curEl as Element;
        stack.unshift(new ProgressState(this._partDone, portion));

        // Handle namespace declarations. Yes, this must happen before we deal
        // with the tag name.
        this._fireAndProcessEvent(walker, ENTER_CONTEXT_EVENT, curEl, 0);
        const attrIxLim = curEl.attributes.length;
        for (let attrIx = 0; attrIx < attrIxLim; ++attrIx) {
          const attr = curEl.attributes[attrIx];
          if (attr.name === "xmlns") {
            this._fireAndProcessEvent(
              walker, new Event("definePrefix", "", attr.value), curEl, 0);
          }
          else if (attr.name.lastIndexOf("xmlns:", 0) === 0) {
            this._fireAndProcessEvent(
              walker, new Event("definePrefix", attr.name.slice(6), attr.value),
              curEl, 0);
          }
        }

        const tagName = curEl.tagName;
        const parent = curEl.parentNode!;
        const curElIndex = _indexOf(parent.childNodes, curEl);
        let ename = walker.resolveName(tagName, false);
        if (!ename) {
          this._processEventResult(
            [new ValidationError(`cannot resolve the name ${tagName}`)],
            parent, curElIndex);
          // This allows us to move forward. It will certainly cause a
          // validation error, and send salve into its recovery mode for unknown
          // elements.
          ename = new EName("", tagName);
        }

        // Check whether this element is going to be allowed only
        // due to a wildcard.
        this._setPossibleDueToWildcard(curEl, walker, "enterStartTag",
                                       ename.ns, ename.name);
        this._fireAndProcessEvent(
          walker,
          new Event("enterStartTag", ename.ns, ename.name), parent, curElIndex);
        this._setNodeProperty(curEl, "EventIndexBeforeAttributes",
                              events.length);
        this._fireAttributeEvents(walker, curEl);
        this._setNodeProperty(curEl, "EventIndexAfterAttributes",
                              events.length);

        // Leave the start tag.
        this._fireAndProcessEvent(walker, LEAVE_START_TAG_EVENT, curEl, 0);

        stage = this._validationStage = Stage.CONTENTS;
        this._setNodeProperty(curEl, "EventIndexAfterStart", events.length);
        this._cycleEntered--;
        return true; // state change
        // break would be unreachable.
      }
      case Stage.CONTENTS: {
        let node = (this._previousChild === null) ?
          // starting from scratch
          curEl.firstChild :
          // already validation contents
          this._previousChild.nextSibling;

        let textAccumulator: string[] = [];
        let textAccumulatorNode: Node | undefined;

        const flushText = () => {
          if (textAccumulator.length) {
            const event = new Event("text", textAccumulator.join(""));
            const eventResult = walker.fireEvent(event);
            if (eventResult instanceof Array) {
              this._processEventResult(
                eventResult, textAccumulatorNode!.parentNode,
                // We are never without a parentNode here.
                _indexOf(textAccumulatorNode!.parentNode!.childNodes,
                         textAccumulatorNode!));
            }
          }
          textAccumulator = [];
          textAccumulatorNode = undefined;
        };

        while (node !== null) {
          switch (node.nodeType) {
          case Node.TEXT_NODE:
            // Salve does not allow multiple text events in a row. If text
            // is encountered, then all the text must be passed to salve
            // as a single event. We record the text and will flush it to
            // salve later.
            textAccumulator.push((node as Text).data);
            if (!textAccumulatorNode) {
              textAccumulatorNode = node;
            }
            break;
          case Node.ELEMENT_NODE:
            flushText();
            portion /= curEl.childElementCount;
            this._curEl = curEl = node as Element;
            stage = this._validationStage = Stage.START_TAG;
            this._previousChild = null;
            continue stage_change;
          case Node.COMMENT_NODE:
            break; // We just skip over comment nodes.
          default:
            throw new Error(`unexpected node type: ${node.nodeType}`);
          }
          node = node.nextSibling;
        }

        flushText();
        stage = this._validationStage = Stage.END_TAG;
        break;
      }
      case Stage.END_TAG: {
        // We've reached the end...
        if (curEl === this.root) {
          const eventResult = walker.end();
          if (eventResult instanceof Array) {
            this._processEventResult(eventResult, curEl,
                                     curEl.childNodes.length);
          }
          this._runDocumentValidation();
          this._setNodeProperty(curEl, "EventIndexAfter", events.length);
          this._partDone = 1;
          this._stop(this._errors.length > 0 ? WorkingState.INVALID :
                     WorkingState.VALID);
          this._cycleEntered--;
          return false;
        }

        // we need it later
        const originalElement = curEl;
        const tagName = (curEl as Element).tagName;
        let ename = walker.resolveName(tagName, false);
        if (!ename) {
          // We just produce the name name we produced when we encountered the
          // start tag.
          ename = new EName("", tagName);
        }
        this._fireAndProcessEvent(walker,
                                  new Event("endTag", ename.ns, ename.name),
                                  curEl, curEl.childNodes.length);
        this._fireAndProcessEvent(walker, LEAVE_CONTEXT_EVENT,
                                  curEl, curEl.childNodes.length);

        // Go back to the parent
        this._previousChild = curEl;
        // We are never without a parentNode here.
        this._curEl = curEl = curEl.parentNode! as Element;

        let nextDone = this._partDone;
        if (curEl !== this.root) {
          stack.shift();
          const first = stack[0];
          nextDone = first.partDone += portion;
          portion = first.portion;
        }

        this._setWorkingState(WorkingState.WORKING, nextDone);

        this._setNodeProperty(originalElement, "EventIndexAfter",
                              this._validationEvents.length);
        stage = this._validationStage = Stage.CONTENTS;
        this._cycleEntered--;
        return true; // state_change
      }
        // break; would be unreachable
      default:
        throw new Error("unexpected state");
      }
    }
  }

  /**
   * Stops background validation.
   */
  stop(): void {
    this._stop();
  }

  /**
   * This private method takes an argument that allows setting the working state
   * to a specific value. This is useful to reduce the number of
   * ``state-update`` events emitted when some internal operations are
   * performed. The alternative would be to perform a state change before or
   * after the call to ``stop``, which would result in more events being
   * emitted.
   *
   * If the parameter is unused, then the logic is that if we were not yet in a
   * VALID or INVALID state, the stopping now leads to the INCOMPLETE state.
   *
   * @param state The state with which to stop.
   */
  private _stop(state?: WorkingState): void {
    if (this._timeoutId !== undefined) {
      clearTimeout(this._timeoutId);
    }
    this._timeoutId = undefined;

    if (state === undefined) {
      // We are stopping prematurely, update the state
      if (this._workingState === WorkingState.WORKING) {
        this._setWorkingState(WorkingState.INCOMPLETE, this._partDone);
      }
    }
    else {
      this._setWorkingState(state, this._partDone);
    }
  }

  /**
   * Run document-level validation that cannot be modeled by Relax NG.  The
   * default implementation does nothing. Deriving classes may override it to
   * call [[_processError]].
   */
  protected _runDocumentValidation(): void {} // tslint:disable-line: no-empty

  /**
   * Restarts validation from a specific point. After the call returns, the
   * background validation will be in effect. (So calling it on a stopped
   * validator has the side effect of starting it.)
   *
   * @param node The element to start validation from.
   */
  restartAt(node: Node): void {
    // We use `this._restarting` to avoid a costly reinitialization if this
    // method is called twice in a row before any work has had a chance to be
    // done.
    if (!this._restarting) {
      this._restarting = true;
      this._resetTo(node);
    }
    this.start();
  }

  private _erase(el: Element | Document): void {
    this._clearNodeProperties(el);
    let child = el.firstElementChild;
    while (child) {
      this._erase(child);
      child = child.nextElementSibling;
    }
  }

  /**
   * Resets validation to continue from a specific point. Any further work done
   * by the validator will start from the point specified.
   *
   * @param node The element to start validation from.
   *
   * @emits module:validator~Validator#reset-errors
   */
  private _resetTo(node: Node): void {
    // An earlier implementation was trying to be clever and to avoid restarting
    // much earlier than strictly needed. That ended up being more costly than
    // doing this primitive restart from 0 no matter what. Eventually, Validator
    // should be updated so that on large documents, restarting from a location
    // towards the end does not require revalidating the whole document. For
    // now, since wed is used for smallish documents, it would be a premature
    // optimization.

    this._erase(this.root);
    this._validationStage = Stage.CONTENTS;
    this._previousChild = null;
    this._validationWalker = this.schema.newWalker();
    this._validationEvents = [];
    this._curEl = this.root;
    this._partDone = 0;
    this._errors = [];
    this._walkerCache = Object.create(null);
    this._walkerCacheMax = -1;
    /**
     * Tells the listener that it must reset its list of errors.
     *
     * @event module:validator~Validator#reset-errors
     * @type {Object}
     * @property {integer} at The index of the first error that must
     * be deleted. This error and all those after it must be deleted.
     */

    this._events._emit("reset-errors", { at: 0 });
  }

  /**
   * Sets the working state of the validator. Emits a "state-update"
   * event if the state has changed.
   *
   * @param newState The new state of the validator.
   *
   * @param newDone The new portion of work done.
   *
   * @emits module:validator~Validator#state-update
   */
  private _setWorkingState(newState: WorkingState, newDone: number): void {
    let changed = false;
    if (this._workingState !== newState) {
      this._workingState = newState;
      changed = true;
    }

    if (this._partDone !== newDone) {
      this._partDone = newDone;
      changed = true;
    }

    if (changed) {
      /**
       * Tells the listener that the validator has changed state.
       *
       * @event module:validator~Validator#state-update
       */
      this._events._emit("state-update", { state: newState, partDone: newDone });
    }
  }

  /**
   * Gets the validator working state.
   *
   * @returns The working state
   */
  getWorkingState(): WorkingStateData {
    return {
      state: this._workingState,
      partDone: this._partDone,
    };
  }

  /**
   * The current set of errors.
   */
  get errors(): ErrorData[] {
    return this._errors.slice();
  }

  /**
   * Processes the result of firing a tag event. It will emit an "error"
   * event for each error.
   *
   * @param results The results of the walker's ``fireEvent`` call.
   *
   * @param node The data node to which the result belongs.
   *
   * @param index The index into ``node`` to which the result belongs.
   *
   * @emits module:validator~Validator#error
   */
  private _processEventResult(results: ValidationError[],
                              node?: Node | null,
                              index?: number): void {
    for (const result of results) {
      this._processError({ error: result, node: node, index: index });
    }
  }

  /**
   * This method should be called whenever a new error is detected. It
   * records the error and emits the corresponding event.
   *
   * @param error The error found.
   *
   * @emits module:validator~Validator#error
   */
  protected _processError(error: ErrorData): void {
    this._errors.push(error);
    /**
     * Tells the listener that an error has occurred.
     *
     * @event module:validator~Validator#error
     * @type {Object}
     * @property {Object} error The validation error.
     * @property {Node} node The node where the error occurred.
     * @property {integer} index The index in this node.
     */
    this._events._emit("error", error);
  }

  /**
   * Fires all the attribute events for a given element.
   */
  private _fireAttributeEvents(walker: GrammarWalker,
                               el: Element): void {
    // Find all attributes, fire events for them.
    const attributes = el.attributes;
    for (let i = 0; i < attributes.length; ++i) {
      const attr = attributes[i];
      // Skip those attributes which are namespace attributes.
      if ((attr.name === "xmlns") ||
          (attr.name.lastIndexOf("xmlns", 0) === 0)) {
        continue;
      }
      if (this._fireAttributeNameEvent(walker, el, attr)) {
        this._fireAndProcessEvent(
          walker,
          new Event("attributeValue", attr.value), attr, 0);
      }
    }
  }

  /**
   * Fires an attributeName event. If the attribute name is in a namespace and
   * cannot be resolved, the event is not fired.
   *
   * @returns True if the event was actually fired, false if not.
   */
  private _fireAttributeNameEvent(walker: GrammarWalker, el: Element,
                                  attr: Attr): boolean {
    const attrName = attr.name;
    const ename = walker.resolveName(attrName, true);
    if (!ename) {
      this._processError(
        {error: new ValidationError(
          `cannot resolve attribute name ${attrName}`), node: attr, index: 0});
      return false;
    }
    this._setPossibleDueToWildcard(attr, walker, "attributeName",
                                   ename.ns, ename.name);
    this._fireAndProcessEvent(
      walker,
      new Event("attributeName", ename.ns, ename.name), attr, 0);
    return true;
  }

  /**
   * Convenience method to fire events.
   *
   * @param walker The walker on which to fire events.
   *
   * @param event The event to fire.
   *
   * @param el The DOM node associated with this event. Both ``el`` and ``ix``
   * can be undefined for events that have no location associated with them.
   *
   * @param ix The index into ``el`` associated with this event, or a ``Node``
   * which must be a child of ``el``. The index will be computed from the
   * location of the child passed as this parameter in ``el``.
   */
  private _fireAndProcessEvent(walker: GrammarWalker,
                               event: Event,
                               el?: Node | null,
                               ix?: number): void {
    this._validationEvents.push(event);
    const eventResult = walker.fireEvent(event);
    if (eventResult) {
      if (el && ix && typeof ix !== "number") {
        ix = el ? _indexOf(el.childNodes, ix) : undefined;
      }
      this._processEventResult(eventResult, el, ix);
    }
  }

  /**
   * Force an immediate validation which is guaranteed to go at least up to the
   * point specified by ``container, index``, exclusively. These parameters are
   * interpreted in the same way a DOM caret is.
   *
   * If the validation has not yet reached the location specified, validation
   * will immediately be performed to reach the point. If the validation has
   * already reached this point, then this call is a no-op.
   *
   * There is one exception in the way the ``container, index`` pair is
   * interpreted. If the container is the ``root`` that was passed when
   * constructing the Validator, then setting ``index`` to a negative value will
   * result in the validation validating all elements **and** considering the
   * document complete. So unclosed tags or missing elements will be
   * reported. Otherwise, the validation goes up the ``index`` but considers the
   * document incomplete, and won't report the errors that are normally reported
   * at the end of a document. For instance, unclosed elements won't be
   * reported.
   *
   * @param container The location up to where to validate.
   *
   * @param index The location up to where to validate.
   *
   * @param attributes Whether we are interested to validate up to and including
   * the attribute events of the node pointed to by ``container, index``. The
   * validation ends before leaving the start tag.
   *
   * @throws {Error} If ``container`` is not of element or text type.
   */
  private _validateUpTo(container: Node, index: number,
                        attributes: boolean = false): void {
    attributes = !!attributes; // Normalize.
    if (attributes && (!container.childNodes ||
                       container.childNodes[index].nodeType !==
                       Node.ELEMENT_NODE)) {
      throw new Error("trying to validate after attributes but before " +
                      "the end of the start tag on a " +
                      "node which is not an element node");
    }

    // Set these to reasonable defaults. The rest of the code is
    // dedicated to changing these values to those necessary depending
    // on specifics of what is passed to the method.
    let toInspect = container;
    let dataKey: CustomNodeProperty = "EventIndexAfter";

    // This function could be called with container === root if the
    // document is empty or if the user has the caret before the start
    // tag of the first element of the actual structure we want to
    // validate or after the end tag of that element.
    if (container === this.root && index <= 0) {
      if (attributes) {
        dataKey = "EventIndexAfterAttributes";
        toInspect = container.childNodes[index];
      }
      else if (index === 0) {
        // We're before the top element, no events to fire.
        return;
      }
      // default values of toInspect and dataKey are what we want
    }
    else {
      // Damn hoisting.
      let prev;
      if (isAttr(container)) {
        toInspect = container.ownerElement;
        dataKey = "EventIndexBeforeAttributes";
      }
      else {
        switch (container.nodeType) {
        case Node.TEXT_NODE:
          toInspect = (container as any).previousElementSibling;
          if (!toInspect) {
            toInspect = container.parentNode!;
            dataKey = "EventIndexAfterStart";
          }
          break;
        case Node.ELEMENT_NODE:
        case Node.DOCUMENT_FRAGMENT_NODE:
        case Node.DOCUMENT_NODE:
          const node = container.childNodes[index];

          prev = !node ?
            (container as Element).lastElementChild :
            // It may not be an element, in which case we get "undefined".
            (node as Element).previousElementSibling;

          if (prev) {
            toInspect = prev;
          }
          // toInspect's default is fine for the next few options
          else if (attributes) {
            dataKey = "EventIndexAfterAttributes";
            toInspect = node;
          }
          else {
            dataKey = "EventIndexAfterStart";
          }
          break;
        default:
          throw new Error(`unexpected node type: ${container.nodeType}`);
        }
      }
    }

    while (this.getNodeProperty(toInspect, dataKey) === undefined) {
      this._cycle();
    }
  };

  /**
   * Gets the walker which would represent the state of parsing at the point
   * expressed by the parameters. See [[Validator.validateUpTo]] for the details
   * of how these parameters are interpreted.
   *
   * **The walker returned by this function is not guaranteed to be a new
   *   instance. Callers should not modify the walker returned but instead clone
   *   it.**
   *
   * @param container
   *
   * @param index
   *
   * @param attributes Whether we are interested to validate up to but not
   * including the attribute events of the node pointed to by ``container,
   * index``. If ``true`` the walker returned will have all events fired on it
   * up to, and including, those attribute events on the element pointed to by
   * ``container, index``.
   *
   * @returns The walker.
   *
   * @throws {EventIndexException} If it runs out of events or computes an event
   * index that makes no sense.
   */
  // tslint:disable-next-line: max-func-body-length
  private _getWalkerAt(container: Node, index: number,
                       attributes: boolean = false): GrammarWalker {
    attributes = !!attributes; // Normalize.
    if (attributes && (!container.childNodes ||
                       container.childNodes[index].nodeType !==
                       Node.ELEMENT_NODE)) {
      throw new Error("trying to get a walker for attribute events on a " +
                      "node which is not an element node");
    }

    // Make sure we have the data we need.
    this._validateUpTo(container, index, attributes);

    // This function could be called with container === root if the document is
    // empty or if the user has the caret before the start tag of the first
    // element of the actual structure we want to validate or after the end tag
    // of that element.
    if (container === this.root && index <= 0) {
      if (!attributes) {
        // We're before the top element, no events to fire.
        if (index === 0) {
          return this.schema.newWalker();
        }

        // _validateUpTo ensures that the current walker held by the validator
        // is what we want. We can just return it here because it is the
        // caller's reponsibility to either not modify it or clone it.
        return this._validationWalker;
      }
    }

    let walker: GrammarWalker | undefined;
    function fireTextEvent(textNode: Text): void {
      if (!walker) {
        throw new Error("calling fireTextEvent without a walker");
      }
      walker.fireEvent(new Event("text", textNode.data));
    }

    if (isAttr(container)) {
      const el = container.ownerElement;
      walker = this.readyWalker(
        this.getNodeProperty(el, "EventIndexBeforeAttributes")!);

      // Don't fire on namespace attributes.
      if (!(container.name === "xmlns" || container.prefix === "xmlns")) {
        walker = walker.clone();
        this._fireAttributeNameEvent(walker, el, container);
      }
    }
    else {
      switch (container.nodeType) {
      case Node.TEXT_NODE: {
        const prev = (container as Text).previousElementSibling;
        walker = this.readyWalker(
          prev ? this.getNodeProperty(prev, "EventIndexAfter")! :
            this.getNodeProperty(container.parentNode!,
                                 "EventIndexAfterStart")!);

        // We will attempt to fire a text event if our location is inside the
        // current text node.
        //
        // A previous version of this code was also checking whether there is a
        // text node between this text node and prev but this cannot happen
        // because the tree on which validation is performed cannot have two
        // adjacent text nodes. It was also checking whether there was a _text
        // element between prev and this text node but this also cannot happen.
        if (index > 0) {
          walker = walker.clone();
          fireTextEvent(container as Text);
        }
        break;
      }
      case Node.ELEMENT_NODE:
      case Node.DOCUMENT_NODE:
      case Node.DOCUMENT_FRAGMENT_NODE: {
        const node = container.childNodes[index];
        let prev;
        let eventIndex;
        if (!attributes) {
          prev = !node ? (container as Element).lastElementChild :
            (node as Element).previousElementSibling;

          eventIndex = prev ? this.getNodeProperty(prev, "EventIndexAfter")! :
            this.getNodeProperty(container, "EventIndexAfterStart")!;
        }
        else {
          eventIndex = this.getNodeProperty(node, "EventIndexAfterAttributes")!;
        }

        walker = this.readyWalker(eventIndex);

        if (!attributes) {
          // We will attempt to fire a text event if another text node appeared
          // between the node we care about and the element just before it.
          const prevSibling = node && node.previousSibling;
          if (prevSibling &&
              // If the previous sibling is the same as the previous *element*
              // sibbling, then there is nothing *between* that we need to take
              // care of.
              prevSibling !== prev) {
            if (prevSibling.nodeType === Node.TEXT_NODE) {
              walker = walker.clone();
              fireTextEvent(prevSibling as Text);
            }
          }
        }
        break;
      }
      default:
        throw new Error(`unexpected node type: ${container.nodeType}`);
      }
    }

    return walker;
  }

  private readyWalker(eventIndex: number): GrammarWalker {
    //
    // Perceptive readers will notice that the caching being done here could be
    // more aggressive. It turns out that the cases where we have to clone the
    // walker after getting it from the cache are not that frequently used, so
    // there is little to gain from being more aggressive. Furthermore, it is
    // likely that the caching system will change when we implement a saner way
    // to reset validation and segment large documents into smaller chunks.
    //

    if (eventIndex === undefined) {
      throw new EventIndexException();
    }

    const cache = this._walkerCache;
    const max = this._walkerCacheMax;

    let walker = cache[eventIndex];
    if (walker) {
      return walker;
    }

    //
    // Scan the cache for a walker we could use... rather than start from zero.
    //
    // There is no point in trying to be clever by using this._walkerCacheGap to
    // start our search. If _getWalkerAt is called with decreasing positions in
    // the document, then the gap is meaningless for our search. (Such scenario
    // is not a normal usage pattern for _getWalkerAt but it *can* happen so we
    // cannot assume that it won't happen.)
    //
    // Also, the following approach is a bit crude but trying to be clever with
    // Object.keys() and then searching through a sorted list does not yield an
    // appreciable improvement. Maybe on very large documents it would but this
    // module will have to be redesigned to tackle that so there's no point now
    // to be cleverer than this. We also tested using a sparse Array for the
    // cache and got visibly worse performance. And we tested to see if a flag
    // indicating if the cache has anything in it would help avoid doing a long
    // search but it maked things worse. Basically, it seems that the typical
    // usage pattern of _getWalkerAt is such that it will usually be called in
    // increasing order of position in the document.
    //
    let searchIx = eventIndex;
    if (searchIx >= max) {
      searchIx = max;
      walker = cache[searchIx];
    }
    else {
      while (!walker && --searchIx >= 0) {
        walker = cache[searchIx];
      }
    }

    if (walker) {
      walker = walker.clone();
    }
    else {
      walker = this.schema.newWalker();
      searchIx = 0;
    }

    for (let ix = searchIx; ix < eventIndex; ++ix) {
      walker.fireEvent(this._validationEvents[ix]);
    }

    // This is a bit arbitrary to find a balance between caching too much
    // information and spending too much time computing walkers.
    if (eventIndex - searchIx >= this._walkerCacheGap) {
      cache[eventIndex] = walker;
      this._walkerCacheMax = Math.max(eventIndex, max);
    }

    return walker;
  }

  /**
   * Returns the set of possible events for the location specified by the
   * parameters.
   *
   * @param container Together with ``index`` this parameter is interpreted to
   * form a location.
   *
   * @param index Together with ``container`` this parameter is interpreted to
   * form a location.
   *
   * @param attributes
   *
   * @returns A set of possible events.
   */
  possibleAt(container: Node, index: number, attributes: boolean = false):
  EventSet {
    const walker = this._getWalkerAt(container, index, attributes);
    // Calling possible does not *modify* the walker.
    return walker.possible();
  }

  /**
   * Finds the locations in a node where a certain validation event is
   * possible.
   *
   * @param container A node.
   *
   * @param event The event to search for. The event should be presented in the
   * same format used for ``fireEvent``.
   *
   * @returns The locations in ``container`` where the event is possible.
   */
  possibleWhere(container: Node, event: Event): number[] {
    const ret = [];
    for (let index = 0; index <= container.childNodes.length; ++index) {
      const possible = this.possibleAt(container, index);
      if (possible.has(event)) {
        ret.push(index);
      }
      else if (event.params[0] === "enterStartTag" ||
               event.params[0] === "attributeName") {
        // In the case where we have a name pattern as the 2nd parameter, and
        // this pattern can be complex or have wildcards, then we have to check
        // all events one by one for a name pattern match. (While enterStartTag,
        // endTag and attributeName all have name patterns, endTag cannot be
        // complex or allow wildcards because what it allows much match the tag
        // that started the current element.
        for (const candidate of possible.toArray()) {
          if (candidate.params[0] === event.params[0] &&
              candidate.params[1].match(event.params[1], event.params[2])) {
            ret.push(index);
            break;
          }
        }
      }
    }
    return ret;
  };

  /**
   * Validate a DOM fragment as if it were present at the point specified in the
   * parameters in the DOM tree being validated.
   *
   * WARNING: This method will not catch unclosed elements. This is because the
   * fragment is not considered to be a "complete" document. Unclosed elements
   * or fragments that are not well-formed must be caught by other means.
   *
   * @param container The location in the tree to start at.
   *
   * @param index The location in the tree to start at.
   *
   * @param toParse The fragment to parse.
   *
   * @returns Returns an array of errors if there is an error. Otherwise returns
   * false.
   */
  speculativelyValidate(container: Node, index: number,
                        toParse: Node | Node[]): ErrorData[] | false {
    let clone;
    if (toParse instanceof Array) {
      clone = container.ownerDocument.createDocumentFragment();
      for (const child of toParse) {
        clone.insertBefore(child.cloneNode(true), null);
      }
    }
    else {
      clone = toParse.cloneNode(true);
    }

    const root = container.ownerDocument.createElement("div");
    root.insertBefore(clone, null);

    return this.speculativelyValidateFragment(container, index, root);
  }

  /**
   * Validate a DOM fragment as if it were present at the point specified in the
   * parameters in the DOM tree being validated.
   *
   * WARNING: This method will not catch unclosed elements. This is because the
   * fragment is not considered to be a "complete" document. Unclosed elements
   * or fragments that are not well-formed must be caught by other means.
   *
   * @param container The location in the tree to start at.
   *
   * @param index The location in the tree to start at.
   *
   * @param toParse The fragment to parse. See above.
   *
   * @returns Returns an array of errors if there is an error. Otherwise returns
   * false.
   */
  speculativelyValidateFragment(container: Node, index: number,
                                toParse: Element):
  ErrorData[] | false {
    // This is useful for pure-JS code that may be calling this.
    if (toParse.nodeType !== Node.ELEMENT_NODE) {
      throw new Error("toParse is not an element");
    }

    // We create a new validator with the proper state to parse the fragment
    // we've been given.
    const dup = new Validator(this.schema, toParse);

    // We have to clone the walker to prevent messing up the internal cache.
    dup._validationWalker = this._getWalkerAt(container, index).clone();

    // This forces validating the whole fragment
    dup._validateUpTo(toParse, toParse.childNodes.length);
    if (dup._errors.length) {
      return dup._errors;
    }

    return false;
  }

  /**
   * Obtain the validation errors that belong to a specific node.
   *
   * The term "that belong to" has a specific meaning here:
   *
   * - An error in the contents of an element belongs to the element whose
   *   contents are incorrect. For instance if in the sequence
   *   ``<foo><blip/></foo>`` the tag ``<blip/>`` is out of place, then the
   *   error belongs to the node for the element ``foo``, not the node for the
   *   element ``blip``.
   *
   * - Attribute errors belong to the element node to which the attributes
   *   belong.
   *
   * @param node The node whose errors we want to get.
   *
   * @returns The errors.
   */
  getErrorsFor(node: Node): ErrorData[] {
    const parent = node.parentNode;
    if (!parent) {
      throw new Error("node without a parent!");
    }
    // Validate to after the closing tag of the node.
    this._validateUpTo(parent, _indexOf(parent.childNodes, node) + 1);
    const ret = [];
    for (const errorData of this._errors) {
      if (errorData.node === node) {
        ret.push(errorData);
      }
    }
    return ret;
  }

  /**
   * Sets a flag indicating whether a node is possible only due to a name
   * pattern wildcard, and emits an event if setting the flag is a change from
   * the previous value of the flag. It does this by inspecting the event that
   * would be fired when ``node`` is validated. The parameters ``eventName``,
   * ``ns`` and ``name`` are used to determine what we are looking for among
   * possible events.
   *
   * @param node The node we want to check.
   *
   * @param walker A walker whose last fired event is the one just before the
   * event that would be fired when validating ``node``.
   *
   * @param eventName The event name we are interested in.
   *
   * @param ns The namespace to use with the event.
   *
   * @param name The name to use with the event.
   *
   * @emits module:validator~Validator#event:possible-due-to-wildcard-change
   *
   */
  private _setPossibleDueToWildcard(node: Node,
                                    walker: GrammarWalker,
                                    eventName: string,
                                    ns: string,
                                    name: string): void {
    const previous = this.getNodeProperty(node, "PossibleDueToWildcard");
    const possible = isPossibleDueToWildcard(walker, eventName, ns, name);
    this._setNodeProperty(node, "PossibleDueToWildcard", possible);
    if (previous === undefined || previous !== possible) {
      /**
       * Tells the listener that a node's flag indicating whether it is possible
       * only due to a wildcard has changed.
       *
       * @event module:validator~Validator#possible-due-to-wildcard-change
       *
       * @type {Node} The node whose flag has changed.
       */
      this._events._emit("possible-due-to-wildcard-change", node);
    }
  };
}
