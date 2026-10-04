using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

internal static class LastWriteRecord
{
    internal static string RefOfTheOnlyPlugin(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "for-each-ref", "--format=%(refname)", "refs/medit/")
            .Trim();
}
