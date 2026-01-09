# PKG Fact Extraction Workspace

This workspace is used by PKG Core service for automated fact extraction via Claude CLI.

## Purpose

Extract structured facts from text messages about people and organizations.

## Available Agents

- `fact-extractor` - Extracts facts from messages in JSON format

## Usage

This directory is used programmatically by `FactExtractionService` in PKG Core.
Claude CLI is called with `--print --model haiku` for cost-efficient extraction.

## Output Format

All responses must be valid JSON arrays:
```json
[
  {
    "factType": "position",
    "value": "CEO",
    "confidence": 0.9,
    "sourceQuote": "exact quote from text"
  }
]
```
