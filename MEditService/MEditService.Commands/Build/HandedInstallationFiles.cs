using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The installation files a request handed, checked against what a manifest pins.</summary>
internal sealed class HandedInstallationFiles(IModFolderRepository repository, IReadOnlyList<InstallationFile> handed)
{
    /// <summary>The handed file that is <paramref name="named"/>, or why it is not. <paramref name="unreadable"/> is why the
    /// request could not read an installation file, by name.</summary>
    public (InstallationFile? File, PackageContents.Lack? Lack) Of(ManifestPackage.InstallationFile named, IReadOnlyDictionary<string, string>? unreadable = null)
    {
        var file = handed.FirstOrDefault(candidate => repository.InstallationFileName(candidate.Path) == named.Name);
        if (file is null)
        {
            return (null, unreadable?.TryGetValue(named.Name, out var why) == true
                ? new PackageContents.Lack.InstallationFileUnreadable(named.Name, why) : new PackageContents.Lack.InstallationFileMissing(named));
        }
        if (!repository.InstallationFileExists(file.Path)) return (null, new PackageContents.Lack($"installation file '{named.Name}' is not in the downloads folder"));
        if (named.Hash != file.Hash) return (null, new PackageContents.Lack($"installation file '{named.Name}' has other bytes"));
        return (file, null);
    }
}
