using MEditService.PluginAdapter;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.TestSupport;

/// <summary>Mutagen's own read parameters for a plugin's Strings folder, built from Mutagen's
/// public surface, for tests that open real fixture plugins straight through ModFactory.</summary>
public static class MutagenReadParameters
{
    public static void EnsureLocalAppDataDefault()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    public static BinaryReadParameters ForRead(PluginStrings strings)
    {
        EnsureLocalAppDataDefault();
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
