// Conventional Commits med syncs egne typer. Sync har skrevet release-, design-,
// polish-, ops- og eng-commits siden v0.1, og overskriftene bærer D- og
// PR-nummer (ofte over 100 tegn). Sjekken skal håndheve formen, ikke skrive om
// vanene — derfor utvidet type-liste og ingen lengdegrense. (D-101)
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "build",
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
        "release",
        "design",
        "polish",
        "ops",
        "eng",
      ],
    ],
    "header-max-length": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "subject-case": [0],
  },
};
