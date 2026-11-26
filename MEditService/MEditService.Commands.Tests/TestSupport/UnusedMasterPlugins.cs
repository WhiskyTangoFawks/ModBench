using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Plugins whose header declares masters no record references, which Mutagen's writer would prune.</summary>
public static class UnusedMasterPlugins
{
    public static GeneratedPlugin Recordless => new("Portrait Cache.esp", RawPlugin.Plugin(RawPlugin.Tes4(0x801, 0, false, ["Fallout4.esm"])));
}
