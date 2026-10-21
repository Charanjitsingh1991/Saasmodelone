# ADR 0001 — Modular monolith first

Status: accepted · October 2026

## Context

SaaSModels One must keep payroll cost, project time and invoicing consistent. The team is small. The first customers are 50–500 person service businesses, not enterprises with independent scaling needs per module. Microservices would introduce distributed transactions, duplicate authorization and operational overhead before product-market fit.

## Decision

Build one deployable API/web service and one worker, backed by one PostgreSQL database and one object store. Separate modules by owned tables and application services. Enforce boundaries in code review and with database ownership, not network calls.

A module may be extracted only when a measured bottleneck or a compliance boundary justifies it, and when the extraction preserves transactional invariants.

## Consequences

- Cross-module reads and transactions stay simple and correct.
- One deployment and one on-call surface.
- Module boundaries require discipline; the build must reject cross-module table writes in review and, where practical, in lint/tests.
- Horizontal scaling is coarse-grained until extraction.
- A future extraction needs event/contract work that is deliberately deferred.
