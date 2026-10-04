using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The tests' view of the binary Modbench last wrote, and the states no write reaches: a
/// record gone, a record locked, a write interrupted.</summary>
internal static class LastWriteRecord
{
    internal static IReadOnlyList<string> Of(string modFolder, string pluginName) =>
        SourceRepository.Over(modFolder, GameRelease.Fallout4)
            .LastWrittenBinarySha256s(new PluginAddress(pluginName, Path.GetFileName(modFolder)));

    internal static void Interrupt(string modFolder, string pluginName, string binarySha256, Action write) =>
        Assert.Throws<IOException>(() => SourceRepository.Over(modFolder, GameRelease.Fallout4).WriteBinary(
            new PluginAddress(pluginName, Path.GetFileName(modFolder)), binarySha256, () =>
            {
                write();
                throw new IOException("interrupted");
            }));

    internal static void Delete(string modFolder) =>
        GitProbe.Run(GitDir(modFolder), modFolder, "update-ref", "-d", RefOfTheOnlyPlugin(modFolder));

    internal static string LockFileOfTheOnlyPlugin(string modFolder) =>
        Path.Combine(GitDir(modFolder), RefOfTheOnlyPlugin(modFolder) + ".lock");

    private static string GitDir(string modFolder) => Path.Combine(modFolder, ".git");

    private static string RefOfTheOnlyPlugin(string modFolder) =>
        GitProbe.Run(GitDir(modFolder), modFolder, "for-each-ref", "--format=%(refname)", "refs/medit/").Trim();
}
