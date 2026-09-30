using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.Codec.Schema;

/// <summary>Whether a release's format carries the light-master (.esl) flag — Mutagen's
/// GameConstants, the one source CreatePluginHandler's refusal and Queries' answer both read.</summary>
public static class LightPluginSupport
{
    public static bool Of(GameRelease release) => GameConstants.Get(release).SmallMasterFlag is not null;
}
