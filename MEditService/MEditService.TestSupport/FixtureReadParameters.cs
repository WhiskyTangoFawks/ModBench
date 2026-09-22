using MEditService.PluginAdapter;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Strings;

namespace MEditService.TestSupport;

/// <summary>Held for the maintainer, like <see cref="GitProbe"/>: a test needing a raw, live
/// Mutagen mod has no door to build these from (ADR-0005 invariant 2 forbids one).</summary>
public static class FixtureReadParameters
{
    // Mutagen's listings resolution reads the LocalAppData environment variable with no
    // injectable seam; a fixture's own strings folder below stops the implicit lookup, so this
    // only fills a placeholder when nothing real is there.
    public static BinaryReadParameters For(PluginStrings strings)
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());

        return new BinaryReadParameters
        {
            StringsParam = new StringsReadParameters
            {
                StringsFolderOverride = strings.Folder,
                BsaFolderOverride = strings.ModFolder ?? strings.DataFolderPath,
            },
        };
    }
}
