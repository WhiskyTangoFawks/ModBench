using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Build;

/// <summary>A mod to build, by name, with the source folder whose build configuration names its folder, the folder,
/// and its installation files in the mod manager's order.</summary>
public sealed record ModToBuild(string Name, string SourceFolder, string Folder, IReadOnlyList<InstallationFile> InstallationFiles);

/// <summary>The instance's facts a build needs: the suffix the mod manager gives an excluded file's name, and the
/// variants of the game's archives from the per-release table, none when it names none.</summary>
public sealed record InstanceToBuild(string ExcludedSuffix, ArchiveVariants? Archives);

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A mod of the selection that built. Overwritten names each file replaced that held other bytes, a plugin's
/// only when it changed outside Modbench (A source mod, story 4). Failure is what stopped the build part way.</summary>
public sealed record BuiltMod(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused,
    IReadOnlyList<ItemRefused<string, ArchiveRefusal>> ArchivesRefused,
    IReadOnlyList<string> Overwritten,
    string? Failure);
