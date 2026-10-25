using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>An instance of any game, whose test adds the plugins in load order.</summary>
internal sealed class GameInstance(GameRelease release) : TestInstance(release)
{
    internal PluginAddress AddPlugin(IMod mod, string origin, bool compiledPlugin) => Add(mod, origin, compiledPlugin);
}
