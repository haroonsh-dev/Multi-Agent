"""Orchestration logger -- prints beautiful step-by-step pipeline progress to terminal."""

import time
import sys
import io

# Force UTF-8 on stdout/stderr if possible
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass


# ANSI colors
class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    GRAY = "\033[90m"
    GREEN_BG = "\033[102m"
    RED_BG = "\033[101m"
    BLACK = "\033[30m"


def _enable_ansi():
    if sys.platform == "win32":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


_enable_ansi()

H = "-"  # horizontal line char
V = "|"  # vertical line char
TL = "+-"  # top-left
TR = "-+"  # top-right
BL = "+-"  # bottom-left
BR = "-+"  # bottom-right


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n != 1 else ''}"


class OrchestrationLogger:
    def __init__(self, document_title: str = "", document_id: str = ""):
        self.document_title = document_title
        self.document_id = document_id
        self.start_time = time.time()
        self._step_count = 0
        self._total_steps = 0

    def set_total_steps(self, n: int):
        self._total_steps = n

    def _step_header(self, label: str):
        self._step_count += 1
        step_str = f"STEP {self._step_count}/{self._total_steps}" if self._total_steps else f"STEP {self._step_count}"
        print()
        print(f"  {C.BOLD}{C.CYAN}{TL}{step_str}: {label} {TR}{C.RESET}")
        print(f"  {C.CYAN}{V}{C.RESET}")

    def _line(self, text: str, color=C.WHITE):
        print(f"  {C.CYAN}{V}{C.RESET} {color}{text}{C.RESET}")

    # -- Public API --

    def start(self, subtitle: str = ""):
        print()
        print(f"  {C.BOLD}{C.WHITE}+{H*60}+{C.RESET}")
        print(f"  {C.BOLD}{C.WHITE}{V}{C.RESET}  {C.BOLD}{C.BLUE}VISIBILITY DOCS AI - AGENT ORCHESTRATION{C.RESET}{C.WHITE}        {V}{C.RESET}")
        print(f"  {C.BOLD}{C.WHITE}+{H*60}+{C.RESET}")
        print()
        print(f"  {C.BOLD}{C.YELLOW}[DOC]{C.RESET}  Document: {C.BOLD}{self.document_title}{C.RESET}")
        if self.document_id:
            print(f"  {C.DIM}   ID: {self.document_id}{C.RESET}")
        if subtitle:
            print(f"  {C.DIM}   {subtitle}{C.RESET}")

    def step(self, label: str):
        self._step_header(label)

    def info(self, msg: str):
        self._line(f" [i]  {msg}")

    def ok(self, msg: str):
        self._line(f"  {C.GREEN}[OK]{C.RESET}  {msg}")

    def warn(self, msg: str):
        self._line(f"  {C.YELLOW}[!]{C.RESET}  {msg}", C.YELLOW)

    def fail(self, msg: str):
        self._line(f"  {C.RED}[FAIL]{C.RESET}  {msg}", C.RED)

    def agent_call(self, agent_name: str, prompt_file: str = "", provider: str = ""):
        parts = [f"Agent: {C.BOLD}{agent_name}{C.RESET}"]
        if prompt_file:
            parts.append(f"Prompt: {C.DIM}{prompt_file}{C.RESET}")
        if provider:
            parts.append(f"Provider: {C.DIM}{provider}{C.RESET}")
        self._line("  " + "  |  ".join(parts), C.MAGENTA)

    def result(self, key: str, value: str, color=C.WHITE):
        self._line(f"  -> {key}: {color}{value}{C.RESET}")

    def end(self, status: str = "processed"):
        total = time.time() - self.start_time
        print()
        if status in ("processed", "completed"):
            badge = f"{C.GREEN_BG}{C.BLACK} [OK] {C.RESET}"
            color = C.GREEN
        else:
            badge = f"{C.RED_BG}{C.BLACK} [FAIL] {C.RESET}"
            color = C.RED
        print(f"  {C.BOLD}{color}+{H*60}+{C.RESET}")
        print(f"  {C.BOLD}{color}{V}{C.RESET}  {badge}  {C.BOLD}PIPELINE COMPLETE{C.RESET}  |  Status: {C.BOLD}{status}{C.RESET}  |  Total: {C.BOLD}{total:.1f}s{C.RESET}  {color}{V}{C.RESET}")
        print(f"  {C.BOLD}{color}+{H*60}+{C.RESET}")
        print()

    def divider(self):
        print(f"  {C.DIM}{H*62}{C.RESET}")

    # ── Chat-specific methods ──

    def chat_start(self, question: str, session_id: str = "", doc_count: int = 0):
        print()
        print(f"  {C.BOLD}{C.WHITE}+{H*60}+{C.RESET}")
        print(f"  {C.BOLD}{C.WHITE}{V}{C.RESET}  {C.BOLD}{C.BLUE}VISIBILITY DOCS AI - CHAT ORCHESTRATION{C.RESET}{C.WHITE}  {V}{C.RESET}")
        print(f"  {C.BOLD}{C.WHITE}+{H*60}+{C.RESET}")
        print()
        print(f"  {C.BOLD}{C.YELLOW}[Q]{C.RESET}  {question}")
        if session_id:
            print(f"  {C.DIM}   Session: {session_id}{C.RESET}")
        if doc_count:
            print(f"  {C.DIM}   Documents attached: {doc_count}{C.RESET}")

    def search_strategy(self, name: str, params: str = ""):
        step_str = f"SEARCH — {name}"
        print()
        print(f"  {C.BOLD}{C.CYAN}+-{step_str} {TR}{C.RESET}")
        print(f"  {C.CYAN}{V}{C.RESET}")
        if params:
            self._line(f"Params: {C.DIM}{params}{C.RESET}")

    def search_result(self, strategy: str, found: int, new: int, extra: str = ""):
        icon = C.GREEN + "[OK]" if found > 0 else C.YELLOW + "[!]"
        label = f"{icon}{C.RESET}  {strategy} returned {C.BOLD}{_plural(found, 'result')}{C.RESET}"
        if new > 0:
            label += f" ({new} new)"
        if extra:
            label += f" | {extra}"
        self._line(label)

    def source_item(self, idx: int, title: str, doc_type: str, score: float):
        connector = "├─" if idx > 0 else " └─"
        self._line(f" {connector} {C.BOLD}{title}{C.RESET}  ({C.DIM}{doc_type}, score: {score:.2f}{C.RESET})")

    def llm_call(self, model: str, context_len: int, question_len: int, source_count: int, provider: str = None, **kwargs):
        print()
        print(f"  {C.BOLD}{C.CYAN}+-LLM CALL {TR}{C.RESET}")
        print(f"  {C.CYAN}{V}{C.RESET}")
        if provider:
            self._line(f"Provider: {C.BOLD}{provider.upper()}{C.RESET}")
        self._line(f"Model: {C.BOLD}{model}{C.RESET}")
        self._line(f"Context: {_plural(context_len, 'char')} from {_plural(source_count, 'source')}")
        self._line(f"Question: {_plural(question_len, 'char')}")
        prov_label = provider.upper() if provider else "AI"
        self._line(f"Calling {prov_label} API...")

    def llm_response(self, duration: float, output_chars: int, finish_reason: str = "stop"):
        self._line(f"  {C.GREEN}[OK]{C.RESET}  Response received in {C.BOLD}{duration:.1f}s{C.RESET} ({_plural(output_chars, 'char')})")
        if finish_reason:
            self._line(f"     Finish reason: {C.DIM}{finish_reason}{C.RESET}")

    def chat_end(self, total_time: float, sources_count: int):
        print()
        print(f"  {C.BOLD}{C.GREEN}+{H*60}+{C.RESET}")
        print(f"  {C.BOLD}{C.GREEN}{V}{C.RESET}  {C.GREEN_BG}{C.BLACK} [OK] {C.RESET}  {C.BOLD}CHAT COMPLETE{C.RESET}  |  {_plural(sources_count, 'source')}  |  Total: {C.BOLD}{total_time:.1f}s{C.RESET}  {C.GREEN}{V}{C.RESET}")
        print(f"  {C.BOLD}{C.GREEN}+{H*60}+{C.RESET}")
        print()


# Singleton
_orch_logger: OrchestrationLogger | None = None


def get_logger() -> OrchestrationLogger:
    global _orch_logger
    if _orch_logger is None:
        _orch_logger = OrchestrationLogger()
    return _orch_logger


def reset_logger(title: str = "", doc_id: str = "") -> OrchestrationLogger:
    global _orch_logger
    _orch_logger = OrchestrationLogger(title, doc_id)
    return _orch_logger


def get_chat_logger() -> OrchestrationLogger:
    """Get a singleton logger instance for chat orchestration."""
    global _orch_logger
    if _orch_logger is None:
        _orch_logger = OrchestrationLogger()
    return _orch_logger
