using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>One malformed-plugin diagnosis the Index projected from a copy's binary, in the
/// binary's record order.</summary>
public sealed record PluginDiagnosisRow(PluginCopyKey Plugin, PluginDiagnosis Diagnosis);
