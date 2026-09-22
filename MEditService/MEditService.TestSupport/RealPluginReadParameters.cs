using MEditService.PluginAdapter;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Strings;

namespace MEditService.TestSupport.TestSupport;

/// <summary>Mutagen's own read parameters, from its public surface, for a test opening a real
/// fixture plugin straight through ModFactory.</summary>
public static class RealPluginReadParameters
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
