import re
from dataclasses import dataclass, field

_REQUIRED = {
    "Package ID":               r"Package ID\s*:",
    "iFlow ID":                 r"iFlow ID\s*:",
    "Integration Flow Structure": r"Integration Flow Structure\s*:",
    "Numbered step":            r"^\s*1\.",
    "Important section":        r"^Important\s*:",
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
        flags = re.MULTILINE
        if not re.search(pattern, text, flags):
            missing.append(label)
    return ValidationResult(is_valid=len(missing) == 0, missing=missing)
