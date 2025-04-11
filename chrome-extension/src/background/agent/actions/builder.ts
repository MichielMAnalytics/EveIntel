import { ActionResult, type AgentContext } from '@src/background/agent/types';
import {
  clickElementActionSchema,
  doneActionSchema,
  extractContentActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  scrollDownActionSchema,
  scrollUpActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  cacheContentActionSchema,
  selectDropdownOptionActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
} from './schemas';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { PromptTemplate } from '@langchain/core/prompts';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ExecutionState, Actors } from '../event/types';

const logger = createLogger('Action');

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    if (isEmptySchema) {
      return await this.handler({});
    }

    const parsedArgs = this.schema.schema.safeParse(input);
    if (!parsedArgs.success) {
      const errorMessage = parsedArgs.error.message;
      throw new InvalidInputError(errorMessage);
    }
    return await this.handler(parsedArgs.data);
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema.nullable().describe(action.schema.description);
    schema = schema.extend({
      [action.name()]: actionSchema,
    });
  }
  return schema.partial();
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: BaseChatModel;

  constructor(context: AgentContext, extractorLLM: BaseChatModel) {
    this.context = context;
    this.extractorLLM = extractorLLM;
  }

  buildDefaultActions() {
    const actions = [];

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
      return new ActionResult({
        isDone: true,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    const searchGoogle = new Action(async (input: { query: string }) => {
      const context = this.context;
      const msg = `Searching for "${input.query}" in Google`;
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, msg);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`, true);

      const msg2 = `Searched for "${input.query}" in Google (background)`;
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const goToUrl = new Action(async (input: { url: string }) => {
      const msg = `Navigating to ${input.url}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, msg);

      // Always use background mode (true parameter)
      await this.context.browserContext.navigateTo(input.url, true);

      const msg2 = `Navigated to ${input.url} (in background)`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (_input = {}) => {
      const msg = 'Navigating back';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, msg);

      // Get current page in background mode
      const page = await this.context.browserContext.getCurrentPage({ background: true });
      await page.goBack();
      const msg2 = 'Navigated back (background)';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const todo = input.desc || `Click element with index ${input.index}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

        const page = await this.context.browserContext.getCurrentPage({ background: true });
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(`Element with index ${input.index} does not exist - retry or use alternative actions`);
        }

        // Check if element is a file uploader
        if (await page.isFileUploader(elementNode)) {
          const msg = `Index ${input.index} - has an element which opens file upload dialog. To upload files please use a specific function to upload files`;
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        try {
          const initialTabIds = await this.context.browserContext.getAllTabIds();
          await page.clickElementNode(this.context.options.useVision, elementNode);
          let msg = `Clicked button with index ${input.index}: ${elementNode.getAllTextTillNextClickableElement(2)}`;
          logger.info(msg);

          // TODO: could be optimized by chrome extension tab api
          const currentTabIds = await this.context.browserContext.getAllTabIds();
          if (currentTabIds.size > initialTabIds.size) {
            const newTabMsg = 'New tab opened - switching to it';
            msg += ` - ${newTabMsg}`;
            logger.info(newTabMsg);
            // find the tab id that is not in the initial tab ids
            const newTabId = Array.from(currentTabIds).find(id => !initialTabIds.has(id));
            if (newTabId) {
              await this.context.browserContext.switchTab(newTabId);
            }
          }
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          const msg = `Element no longer available with index ${input.index} - most likely the page changed`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const todo = input.desc || `Input text into index ${input.index}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

        const page = await this.context.browserContext.getCurrentPage({ background: true });
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(`Element with index ${input.index} does not exist - retry or use alternative actions`);
        }

        await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text);
        const msg = `Input ${input.text} into index ${input.index}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `Switching to tab ${input.tab_id}`);
      // Always use background mode (true) to avoid changing the user's focus
      await this.context.browserContext.switchTab(input.tab_id, true);
      const msg = `Switched to tab ${input.tab_id} (in background)`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.ACT_START,
        `Opening ${input.url} in new tab (background)`,
      );

      // Ensure we create a new tab in background mode
      const page = await this.context.browserContext.openTab(input.url, true);

      // Store the tab ID in the action result for future reference
      const msg = `Opened ${input.url} in new tab (ID: ${page.tabId}, background mode)`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({
        extractedContent: msg,
        includeInMemory: true,
      });
    }, openTabActionSchema);
    actions.push(openTab);

    // Add close tab action
    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const tabId = input.tab_id;

      if (tabId) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `Closing tab ${tabId}`);
        await this.context.browserContext.closeTab(tabId);
        const msg = `Closed tab ${tabId}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } else {
        // Get current tab and close it
        const page = await this.context.browserContext.getCurrentPage({ background: true });
        const currentTabId = page.tabId;

        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `Closing current tab ${currentTabId}`);
        await this.context.browserContext.closeTab(currentTabId);
        const msg = `Closed current tab ${currentTabId}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      }
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Actions
    // TODO: this is not used currently, need to improve on input size
    const extractContent = new Action(async (input: z.infer<typeof extractContentActionSchema.schema>) => {
      const goal = input.goal;
      const page = await this.context.browserContext.getCurrentPage({ background: true });
      const content = await page.getReadabilityContent();
      const promptTemplate = PromptTemplate.fromTemplate(
        'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}',
      );
      const prompt = await promptTemplate.invoke({ goal, page: content.content });

      try {
        const output = await this.extractorLLM.invoke(prompt);
        const msg = `📄  Extracted from page\n: ${output.content}\n`;
        return new ActionResult({
          extractedContent: msg,
          includeInMemory: true,
        });
      } catch (error) {
        logger.error(`Error extracting content: ${error instanceof Error ? error.message : String(error)}`);
        const msg =
          'Failed to extract content from page, you need to extract content from the current state of the page and store it in the memory. Then scroll down if you still need more information.';
        return new ActionResult({
          extractedContent: msg,
          includeInMemory: true,
        });
      }
    }, extractContentActionSchema);
    actions.push(extractContent);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, cacheContentActionSchema.name);

      const msg = `Cached findings: ${input.content}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    const scrollDown = new Action(async (input: z.infer<typeof scrollDownActionSchema.schema>) => {
      const todo = input.desc || 'Scroll down the page';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

      const page = await this.context.browserContext.getCurrentPage({ background: true });
      await page.scrollDown(input.amount);
      const amount = input.amount !== undefined ? `${input.amount} pixels` : 'one page';
      const msg = `Scrolled down the page by ${amount}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollDownActionSchema);
    actions.push(scrollDown);

    const scrollUp = new Action(async (input: z.infer<typeof scrollUpActionSchema.schema>) => {
      const todo = input.desc || 'Scroll up the page';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

      const page = await this.context.browserContext.getCurrentPage({ background: true });
      await page.scrollUp(input.amount);
      const amount = input.amount !== undefined ? `${input.amount} pixels` : 'one page';
      const msg = `Scrolled up the page by ${amount}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollUpActionSchema);
    actions.push(scrollUp);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const todo = input.desc || `Send keys: ${input.keys}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

      const page = await this.context.browserContext.getCurrentPage({ background: true });
      await page.sendKeys(input.keys);
      const msg = `Sent keys: ${input.keys}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const todo = input.desc || `Scroll to text: ${input.text}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

      const page = await this.context.browserContext.getCurrentPage({ background: true });
      try {
        const scrolled = await page.scrollToText(input.text);
        const msg = scrolled
          ? `Scrolled to text: ${input.text}`
          : `Text '${input.text}' not found or not visible on page`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = `Failed to scroll to text: ${error instanceof Error ? error.message : String(error)}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const todo = `Getting options from dropdown with index ${input.index}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

        const page = await this.context.browserContext.getCurrentPage({ background: true });
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = `Element with index ${input.index} does not exist - retry or use alternative actions`;
          logger.error(errorMsg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(input.index);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\nUse the exact text string in select_dropdown_option';
            logger.info(msg);
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              `Got ${options.length} options from dropdown`,
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = 'No options found in dropdown';
          logger.info(msg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = `Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(errorMsg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const todo = `Select option "${input.text}" from dropdown with index ${input.index}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, todo);

        const page = await this.context.browserContext.getCurrentPage({ background: true });
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = `Element with index ${input.index} does not exist - retry or use alternative actions`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = `Cannot select option: Element with index ${input.index} is a ${elementNode.tagName || 'unknown'}, not a SELECT`;
          logger.error(errorMsg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);
        logger.debug(`Element attributes: ${JSON.stringify(elementNode.attributes)}`);
        logger.debug(`Element tag: ${elementNode.tagName}`);

        try {
          const result = await page.selectDropdownOption(input.index, input.text);
          const msg = `Selected option "${input.text}" from dropdown with index ${input.index}`;
          logger.info(msg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = `Failed to select option: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(errorMsg);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    return actions;
  }

  // Get all options from a native dropdown

  // Select dropdown option for interactive element index by the text of the option you want to select'
}
