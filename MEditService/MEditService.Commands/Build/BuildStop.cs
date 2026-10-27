using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Why a build refused a mod: its kind, and the installation files the request has not handed, as its manifest
/// names them.</summary>
internal sealed record BuildStop(BuildRefusal Kind)
{
    public IReadOnlyList<ManifestPackage.InstallationFile> InstallationFilesNotFound { get; init; } = [];
}
