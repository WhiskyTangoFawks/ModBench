using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod and the one step of its build file to run, as the extension hands them (ADR-0016).</summary>
public sealed record ModToBuild(string Name, string SourceFolder, string Folder, BuildStep Step)
{
    public IReadOnlyList<string> Exclude { get; init; } = [];
}

/// <summary>A built-in step of a build file (formats/build-file-1.schema.json).</summary>
public abstract record BuildStep
{
    private BuildStep()
    {
    }

    /// <summary>Each plugin at the root of the source folder decompiled into its plugin source, by its name; a decompile that
    /// only checks writes nothing.</summary>
    public sealed record Decompile(IReadOnlyList<string> Plugins, bool OnlyChecks = false) : BuildStep;

    /// <summary>Each plugin compiled from its plugin source into the mod's folder, by its name.</summary>
    public sealed record Compile(IReadOnlyList<string> Plugins) : BuildStep;

    /// <summary>Each file or folder copied from the source folder into the mod's folder, by its path in both.</summary>
    public sealed record Copy(IReadOnlyList<string> Paths) : BuildStep;

    /// <summary>Each archive packed from the loose files of the mod's folder.</summary>
    public sealed record Pack(IReadOnlyList<ArchiveToPack> Archives) : BuildStep;
}

/// <summary>An archive by its path in the mod folder, and the loose files it packs there.</summary>
public sealed record ArchiveToPack(string Path, IReadOnlyList<string> Files);

/// <summary>The instance's facts a build needs: the mod manager's exclusion mark, and the archive variants, none when the
/// per-release table names none.</summary>
public sealed record InstanceToBuild(string ExclusionMark, ArchiveVariants? Archives);

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A file a build made, by its path in the mod folder. Vouched for: it holds what the source makes, which a refused
/// plugin's or archive's file does not.</summary>
public sealed record MadeFile(string Path, bool VouchedFor);

/// <summary>A mod whose step ran. Made: each file it made, none after a Failure. Packed: each loose file an archive it made
/// packs, by its path in the folder. Uncommitted and Unpushed: its source's.</summary>
internal sealed record ModBuildOutcome(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused,
    IReadOnlyList<ItemRefused<string, ArchiveRefusal>> ArchivesRefused,
    string? Failure,
    bool Uncommitted = false,
    bool Unpushed = false)
{
    public IReadOnlyList<MadeFile> Made { get; init; } = [];

    public IReadOnlyList<string> Packed { get; init; } = [];

    internal static ModBuildOutcome Stopped(string failure) => new([], [], [], failure);
}
