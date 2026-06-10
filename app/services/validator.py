import re
from dataclasses import dataclass, field

_REQUIRED = {
    "Opening line (Create a new iFlow called)": r'Create a new iFlow called\s*["“]',
    "Component Configuration section":          r"Component Configuration\s*:",
    "Numbered step":                            r"(?:^|\n)\s*1\s*\.",
    "Important section":                        r"(?:^|\n)\s*Important\s*:",
}


@dataclass
class ValidationResult:
    is_valid: bool
    missing: list[str] = field(default_factory=list)

    @property
    def warning(self) -> str | None:
        if self.is_valid:
            return None
        return "Output may be incomplete. Missing: " + ", ".join(self.missing)


def validate(text: str) -> ValidationResult:
    missing = []
    for label, pattern in _REQUIRED.items():
        if not re.search(pattern, text, re.MULTILINE):
            missing.append(label)
    return ValidationResult(is_valid=len(missing) == 0, missing=missing)
