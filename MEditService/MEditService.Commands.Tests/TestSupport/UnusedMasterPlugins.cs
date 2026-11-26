using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A plugin whose header declares a master no record references, which Mutagen's writer prunes.</summary>
public static class UnusedMasterPlugins
{
    public static GeneratedPlugin Recordless => new("Portrait Cache.esp", RawPlugin.Plugin(RawPlugin.Tes4(0x801, 0, false, ["Fallout4.esm"])));
}
