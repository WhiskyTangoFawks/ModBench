using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

/// <summary>A plugin's malformed-record diagnoses from one read of it, with the hash of the bytes they
/// came from, which a repair of them is handed (ADR-0003).</summary>
public sealed record RepairPreviews(string Hash, IReadOnlyList<RepairPreview> Diagnoses);

/// <summary>The malformations of a plugin Mutagen failed to read: those in the record it failed at, and those in the rest.</summary>
public sealed record MalformationScan(IReadOnlyList<RepairPreview> AtFailure, IReadOnlyList<RepairPreview> Elsewhere);

/// <summary>A diagnosis of a malformed record, and the change that repairs it; null when no repair answers it.</summary>
public sealed record RepairPreview(PluginDiagnosis Diagnosis, RepairChange? Change);

/// <summary>What a repair changes in its record, naming any data it drops.</summary>
public sealed record RepairChange(string Description, bool DropsData);
