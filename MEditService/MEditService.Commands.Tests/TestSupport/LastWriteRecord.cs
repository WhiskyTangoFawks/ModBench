using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The tests' view of the binary Modbench last wrote, and the states no write reaches: a
/// record gone, a record locked, a write interrupted.</summary>
internal static class LastWriteRecord
{
    internal static void Interrupt(string modFolder, string pluginName, string binarySha256, Action write) =>
        Assert.Throws<IOException>(() => SourceRepository.Over(ModOf(modFolder), GameRelease.Fallout4).WriteBinary(
            new PluginAddress(pluginName, Path.GetFileName(modFolder)), binarySha256, () =>
            {
                write();
                throw new IOException("interrupted");
            }));

    internal static void Delete(string modFolder) =>
        GitProbe.Run(GitDir(modFolder), modFolder, "update-ref", "-d", RefOfTheOnlyPlugin(modFolder));

    /// <summary>Lets the next ref update through and refuses every one after it. A compile moves the ref
    /// before it writes the binary and again after, so this fails only the second.</summary>
    internal static void RefuseRefUpdatesAfterTheFirst(string modFolder)
    {
        var marker = Path.Combine(modFolder, "first-ref-update");
        GitHooks.Write(modFolder, "reference-transaction", $"[ \"$1\" = prepared ] || exit 0\n[ -e '{marker}' ] && exit 1\n: > '{marker}'");
    }

    internal static void RefuseRefUpdates(string modFolder) =>
        GitHooks.Write(modFolder, "reference-transaction", "[ \"$1\" = prepared ] && exit 1\nexit 0");

    private static PluginProvider.FromMod ModOf(string modFolder) => new(Path.GetFileName(modFolder), modFolder);

    private static string GitDir(string modFolder) => Path.Combine(modFolder, ".git");

    private static string RefOfTheOnlyPlugin(string modFolder) =>
        GitProbe.Run(GitDir(modFolder), modFolder, "for-each-ref", "--format=%(refname)", "refs/medit/").Trim();
}
