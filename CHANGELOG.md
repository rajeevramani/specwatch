# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-10

### Added

- Local reverse proxy for capturing API traffic (`specwatch start <url>`)
- Automatic schema inference from JSON request/response bodies
- OpenAPI 3.1 and 3.0.3 export (`specwatch export`)
- Type inference: string, integer, number, boolean, array, object
- Format detection: email, date, date-time, uri, uuid, int32, int64, double
- Required field detection (fields present in 100% of samples)
- Enum detection for low-cardinality string fields
- Query parameter capture and type inference
- Path parameter inference with contextual naming (`/users/123` → `/users/{userId}`)
- Path parameter type inference (integer when all values numeric)
- Security scheme detection (Bearer, Basic, API Key)
- Multiple response status code support
- Session management with named sessions (`--name`)
- Breaking change detection between sessions (`specwatch diff`)
- Confidence scoring per endpoint
- Non-blocking proxy design (zero latency impact)
- Privacy-first: raw request/response data never stored
- PATCH request bodies exempt from required field marking
- Body size limit (1MB) to prevent memory issues
