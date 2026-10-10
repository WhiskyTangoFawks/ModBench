using MEditService.Codec.Fallout4;
using Mutagen.Bethesda.Fallout4;
using Noggog.WorkEngine;

namespace MEditService.TestSupport;

/// <summary>Fallout 4's whole-mod door, typed for fixtures that build or inspect the mod it reads.</summary>
public static class Fallout4WholeMod
{
    public static Task Serialize(IFallout4ModGetter mod, string folder, CancellationToken cancel = default) =>
        Fallout4Codec.Instance.SerializeWholeMod(mod, folder, InlineWorkDropoff.Instance, cancel);

    public static async Task<IFallout4Mod> Deserialize(string folder, CancellationToken cancel = default) =>
        (IFallout4Mod)await Fallout4Codec.Instance.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, cancel);
}
