(component
  ;; Static fixture: a component that imports an undeclared interface. The host linker only
  ;; provides LangNext interfaces (common/host), so instantiation must fail. Used by the
  ;; check-no-wasi / unlinked-import conformance test instead of an inline WAT string.
  (import "undeclared-func" (func))
)
