namespace MEditService.Ports;

/// <summary>A plugin that could not be opened (ADR-0013), its reason reported here
/// rather than as a failed reconcile. Diagnosis: the defect in its bytes that stopped the read, when
/// one did.</summary>
public record PluginLoadFailure(string Name, string Origin, string Reason, string? Diagnosis = null);
