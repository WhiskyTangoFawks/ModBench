using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

/// <summary>The malformations of a plugin Mutagen failed to read: those in the record it failed at, and those in the rest.</summary>
public sealed record MalformationScan(IReadOnlyList<RepairPreview> AtFailure, IReadOnlyList<RepairPreview> Elsewhere);

/// <summary>A diagnosis of a malformed record, and the change that repairs it; null when no repair answers it.</summary>
public sealed record RepairPreview(PluginDiagnosis Diagnosis, RepairChange? Change);

/// <summary>What a repair changes in its record, naming any data it drops.</summary>
public sealed record RepairChange(string Description);

/// <summary>A plugin's repair written from one read of it: where it was written, what it repaired, and the bytes it was
/// made from, which its verification and its flagged source answer to.</summary>
public sealed class RepairedPlugin
{
    internal RepairedPlugin(string path, IReadOnlyList<RepairPreview> repairs, byte[] original) =>
        (Path, Repairs, Original) = (path, repairs, original);

    public string Path { get; }

    public IReadOnlyList<RepairPreview> Repairs { get; }

    internal byte[] Original { get; }
}
