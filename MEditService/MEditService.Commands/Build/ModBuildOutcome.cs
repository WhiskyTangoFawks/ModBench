using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Build;

/// <summary>A mod to build, as the extension hands it (ADR-0016). Taken: each file the extension wrote into the folder from a
/// package, by its path there, which no asset of the source replaces.</summary>
public sealed record ModToBuild(string Name, string SourceFolder, string Folder)
{
    public IReadOnlyList<string> Exclude { get; init; } = [];

    public IReadOnlyList<ArchiveToPack> Archives { get; init; } = [];

    public IReadOnlyList<string> Taken { get; init; } = [];
}

/// <summary>An archive by its path in the mod folder, and the files it takes: an asset of the source, or a taken file.</summary>
public sealed record ArchiveToPack(string Path, IReadOnlyList<string> Files);

/// <summary>The instance's facts a build needs: the mod manager's exclusion mark, and the archive variants, none when the
/// per-release table names none.</summary>
public sealed record InstanceToBuild(string ExclusionMark, ArchiveVariants? Archives);

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A file a build made, by its path in the mod folder. Vouched for: it holds what the source makes, which a refused
/// plugin's or archive's file does not.</summary>
public sealed record MadeFile(string Path, bool VouchedFor);

/// <summary>A mod that built. Overwritten: each replaced file that held other bytes (A source mod, story 4). Made: each file
/// it made, none after a Failure. Uncommitted and Unpushed: its source's.</summary>
internal sealed record ModBuildOutcome(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused,
    IReadOnlyList<ItemRefused<string, ArchiveRefusal>> ArchivesRefused,
    IReadOnlyList<string> Overwritten,
    string? Failure,
    bool Uncommitted = false,
    bool Unpushed = false)
{
    public IReadOnlyList<MadeFile> Made { get; init; } = [];
}
