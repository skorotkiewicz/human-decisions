import type { Decision, Question } from "./index";

type Pending = Decision & { id: string; status: "pending" };
type Completed = { id: string; status: "answered"; answers: Record<string, { type: string; noul?: number; choice?: string; score?: number; confidence?: number; legend?: Record<string, string> }> };

// ponytail: the website submits definite choice/scale selections; use the API for mixed distributions.
export function buildAnswer(question: Question, selection: string, confidence = 1) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Confidence must be between 0 and 1.");
  if (question.type === "noul") {
    const value = Number(selection);
    if (!selection.trim() || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Choose a probability between 0 and 1.");
    return { type: "noul", noul: value };
  }
  const options = question.type === "choice"
    ? Object.keys(question.criteria as Record<string, string>)
    : (question.criteria as string[]).map((_, index) => String(index));
  if (!options.includes(selection)) throw new Error("Choose an answer for every question.");
  const probabilities = Object.fromEntries(options.map(option => [option, option === selection ? 1 : 0]));
  return question.type === "choice"
    ? { type: "choice", choice: selection, probabilities, confidence }
    : { type: "score", score: Number(selection), probabilities, confidence };
}

function setup() {
  const get = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const notice = get("#notice");
  const panel = get("#decision-panel");
  const queueList = get("#queue-list");
  const refresh = get<HTMLButtonElement>("#refresh-queue");
  const askForm = get<HTMLFormElement>("#ask-form");
  const questionList = get("#question-list");
  const lookupId = get<HTMLInputElement>("#lookup-id");
  const result = get("#result");
  let selectedId: string | null = null;
  let questionNumber = 0;

  function message(text: string, error = false) {
    notice.textContent = text;
    notice.className = error ? "notice error" : "notice";
    notice.hidden = false;
  }
  function report(error: unknown) {
    message(error instanceof Error ? error.message : "Something went wrong. Please try again.", true);
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({ error: `Request failed (${response.status}).` }));
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
    return data as T;
  }
  function showView(view: "ask" | "answer") {
    for (const name of ["ask", "answer"]) {
      const active = name === view;
      get(`#${name}-view`).hidden = !active;
      const tab = get(`#${name}-tab`);
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    }
  }
  get("#answer-tab").onclick = () => showView("answer");
  get("#ask-tab").onclick = () => showView("ask");
  get("#empty-ask").onclick = () => showView("ask");

  function showEmpty(title: string, description: string) {
    const empty = el("div", "", "empty-state");
    const button = el("button", "Create a request ↗", "primary-button");
    button.type = "button";
    button.onclick = () => showView("ask");
    const symbol = el("span", "", "empty-symbol");
    symbol.setAttribute("aria-hidden", "true");
    empty.append(el("p", "ROOM FOR YOUR PERSPECTIVE", "eyebrow"), symbol, el("h2", title), el("p", description), button, el("span", "Real people. Considered answers.", "empty-caption"));
    panel.replaceChildren(empty);
  }

  function range(labelText: string, id: string, value: number, min: number, max: number, step: number) {
    const container = el("div", "", "confidence");
    const label = el("label", labelText);
    label.htmlFor = id;
    const input = el("input");
    input.id = id;
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const output = el("output", `${value}%`);
    output.htmlFor = id;
    input.oninput = () => { output.value = `${input.value}%`; };
    label.append(document.createTextNode(" · "), output);
    container.append(label, input);
    return { container, input };
  }

  function selectDecision(decision: Pending) {
    selectedId = decision.id;
    for (const item of queueList.querySelectorAll<HTMLButtonElement>("button")) {
      const selected = item.dataset.id === selectedId;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    }
    const heading = el("h2", "Read the context. Make your call.");
    heading.tabIndex = -1;
    const context = el("div", "", "context-box");
    const state = typeof decision.state === "string" ? decision.state : JSON.stringify(decision.state, null, 2);
    context.append(el("p", "THE CONTEXT", "eyebrow"), el("p", state));
    const form = el("form");
    const readers: [string, () => ReturnType<typeof buildAnswer>][] = [];
    Object.entries(decision.questions).forEach(([name, question], index) => {
      const fieldset = el("fieldset", "", "answer-question");
      fieldset.append(el("legend", question.instructions));
      const prefix = `answer-${index}`;
      if (question.type === "noul") {
        const control = range("Probability of yes", `${prefix}-probability`, 50, 0, 100, 1);
        control.container.className = "probability";
        const endpoints = el("div", "", "range-label");
        const criteria = question.criteria as Record<string, string> | undefined;
        endpoints.append(el("span", criteria?.false ?? "No"), el("span", criteria?.true ?? "Yes"));
        fieldset.append(control.container, endpoints);
        readers.push([name, () => buildAnswer(question, String(Number(control.input.value) / 100))]);
      } else {
        const labels = question.type === "choice"
          ? Object.entries(question.criteria as Record<string, string>)
          : (question.criteria as string[]).map((label, i) => [String(i), label] as [string, string]);
        const options = el("div", "", "answer-options");
        for (const [value, labelText] of labels) {
          const label = el("label", "", "radio-option");
          const radio = el("input");
          radio.type = "radio";
          radio.name = prefix;
          radio.value = value;
          radio.required = true;
          label.append(radio, el("span", labelText));
          options.append(label);
        }
        const confidence = range("Confidence in your answer", `${prefix}-confidence`, 100, 0, 100, 1);
        fieldset.append(options, confidence.container);
        readers.push([name, () => buildAnswer(question, options.querySelector<HTMLInputElement>("input:checked")?.value ?? "", Number(confidence.input.value) / 100)]);
      }
      form.append(fieldset);
    });
    const footer = el("div", "", "form-footer");
    const submit = el("button", "Send answer ↗", "primary-button");
    submit.type = "submit";
    footer.append(el("span", "Your judgment makes the difference.", "muted small"), submit);
    form.append(el("p", "Choice and scale answers send a definite selection (probability 1). For mixed probabilities or fractional scores, use the API.", "answer-note"), footer);
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = "Sending answer…";
      try {
        const answers = Object.fromEntries(readers.map(([name, read]) => [name, read()]));
        await api(`/v1/decisions/${encodeURIComponent(decision.id)}/answers`, { answers });
        selectedId = null;
        showEmpty("A good call. Thank you.", "Your answer is saved. Pick another request when you’re ready.");
        message("Answer delivered. Someone has a little more clarity now.");
        await loadQueue();
      } catch (error) { report(error); }
      finally { submit.disabled = false; submit.textContent = "Send answer ↗"; }
    };
    panel.replaceChildren(el("p", `YOUR HUMAN JUDGMENT / ${decision.id.slice(-8)}`, "eyebrow"), heading, context, form);
    heading.focus({ preventScroll: true });
  }

  async function loadQueue() {
    refresh.disabled = true;
    queueList.setAttribute("aria-busy", "true");
    try {
      const { decisions } = await api<{ decisions: Pending[] }>("/poll");
      get("#queue-count").textContent = String(decisions.length);
      get("#queue-count").setAttribute("aria-label", `${decisions.length} open requests`);
      queueList.replaceChildren();
      if (!decisions.length) queueList.append(el("p", "All caught up. New requests will appear here when you refresh.", "muted small"));
      for (const decision of decisions) {
        const button = el("button", "", "queue-item");
        button.type = "button";
        button.dataset.id = decision.id;
        button.classList.toggle("selected", selectedId === decision.id);
        button.setAttribute("aria-pressed", String(selectedId === decision.id));
        const questions = Object.values(decision.questions);
        const types = [...new Set(questions.map(question => ({ noul: "YES / NO", choice: "CHOICE", score: "SCALE" })[question.type]))];
        button.append(el("span", types.join(" · "), "type-badge"), el("strong", questions[0]!.instructions), el("small", `${questions.length} question${questions.length === 1 ? "" : "s"} · ${decision.id.slice(-8)}`));
        button.onclick = () => selectDecision(decision);
        queueList.append(button);
      }
      if (selectedId && !decisions.some(decision => decision.id === selectedId)) {
        selectedId = null;
        showEmpty("Someone got there first.", "This request is no longer in the inbox. Choose another to help.");
      }
    } catch (error) { report(error); }
    finally { refresh.disabled = false; queueList.setAttribute("aria-busy", "false"); }
  }
  refresh.onclick = () => void loadQueue();

  function addQuestion() {
    const fragment = get<HTMLTemplateElement>("#question-template").content.cloneNode(true) as DocumentFragment;
    const fieldset = get<HTMLFieldSetElement>("fieldset", fragment);
    fieldset.dataset.name = `question_${++questionNumber}`;
    get("legend", fieldset).textContent = `Question ${String(questionNumber).padStart(2, "0")}`;
    const type = get<HTMLSelectElement>(".question-type", fieldset);
    const criteria = get<HTMLTextAreaElement>(".question-criteria", fieldset);
    const update = () => {
      get(".criteria-label", fieldset).hidden = type.value === "noul";
      criteria.required = type.value !== "noul";
    };
    type.onchange = update;
    get(".remove-question", fieldset).onclick = () => {
      if (questionList.children.length === 1) { message("Keep at least one question in your request.", true); return; }
      fieldset.remove();
    };
    questionList.append(fragment);
    update();
  }
  get("#add-question").onclick = addQuestion;
  addQuestion();

  askForm.onsubmit = async event => {
    event.preventDefault();
    const submit = get<HTMLButtonElement>("#submit-request");
    submit.disabled = true;
    submit.textContent = "Sending request…";
    try {
      const questions = Object.fromEntries([...questionList.querySelectorAll<HTMLFieldSetElement>("fieldset")].map(fieldset => {
        const type = get<HTMLSelectElement>(".question-type", fieldset).value as Question["type"];
        const instructions = get<HTMLInputElement>(".question-instructions", fieldset).value.trim();
        if (!instructions) throw new Error("Please write a question.");
        const labels = get<HTMLTextAreaElement>(".question-criteria", fieldset).value.split("\n").map(label => label.trim()).filter(Boolean);
        if (type !== "noul" && (labels.length < 2 || new Set(labels).size !== labels.length)) throw new Error("Add at least two distinct options, one per line.");
        const criteria = type === "score" ? labels : Object.fromEntries(labels.map(label => [label, label]));
        return [fieldset.dataset.name!, { type, instructions, ...(type === "noul" ? {} : { criteria }) }];
      }));
      const state = get<HTMLTextAreaElement>("#context").value.trim();
      if (!state) throw new Error("Please add some context for your human.");
      const submitted = await api<{ id: string }>("/v1/decisions", { state, questions });
      lookupId.value = submitted.id;
      message(`Request sent. Keep this ID to follow the answer: ${submitted.id}`);
      await checkResult();
      await loadQueue();
      // Keep the draft intact so network errors never discard someone's work.
    } catch (error) { report(error); }
    finally { submit.disabled = false; submit.textContent = "Send request ↗"; }
  };

  async function checkResult() {
    const id = lookupId.value.trim();
    if (!id) throw new Error("Enter a request ID.");
    const decision = await api<Pending | Completed>(`/v1/decisions/${encodeURIComponent(id)}`);
    result.replaceChildren(el("p", decision.status === "pending" ? "Waiting for a human answer." : "An answer has arrived.", "muted small"), el("p", decision.id, "result-id"));
    if (decision.status === "answered") {
      for (const [name, answer] of Object.entries(decision.answers)) {
        const value = answer.type === "noul" ? `${Math.round(answer.noul! * 100)}% yes`
          : answer.type === "choice" ? answer.choice!
          : `${answer.score}${answer.legend?.[String(answer.score)] ? ` · ${answer.legend[String(answer.score)]}` : ""}`;
        const row = el("div", "", "result-answer");
        row.append(el("span", name), el("strong", value));
        if (answer.confidence !== undefined) row.append(el("p", `${Math.round(answer.confidence * 100)}% confidence`, "muted small"));
        result.append(row);
      }
    }
  }
  get<HTMLFormElement>("#lookup-form").onsubmit = async event => {
    event.preventDefault();
    const button = get<HTMLButtonElement>("button", get("#lookup-form"));
    button.disabled = true;
    button.textContent = "Checking…";
    try { await checkResult(); } catch (error) { report(error); }
    finally { button.disabled = false; button.textContent = "Check result ↗"; }
  };
  void loadQueue();
}

if (typeof document !== "undefined") setup();
