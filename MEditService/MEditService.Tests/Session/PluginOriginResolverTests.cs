using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

// #34 / ADR-0036: PluginOriginResolver answers "which origin does this bare filename mean?" for
// every call site that only has a filename to work with — every staged edit's write target, and
// the read routes #296 left resolving server-side. Once a session can hold two copies of one
// filename, that question has two candidate answers and only one correct one: the copy the game
// actually loads.
//
// The rule is scoping, not ordering. `FirstOrDefault(p => p.Name == plugin)` happens to return the
// right plugin today purely because unlisted copies are appended after the load order is built —
// an accident of list order, not an invariant, and one that any future change to how Plugins is
// assembled or sorted would silently break. These tests state the rule directly by putting the
// shadowed copy first.
public sealed class PluginOriginResolverTests
{
    private static IGameSession SessionWith(params PluginMetadata[] plugins) => new StubGameSession(plugins);

    private static PluginMetadata Plugin(string name, string origin, bool inLoadOrder) =>
        new(name, Path: "", LoadOrderIndex: 0, IsLight: false, IsMaster: false, Masters: [], RecordCount: 0,
            IsImmutable: !inLoadOrder, Origin: origin, Participates: inLoadOrder, InLoadOrder: inLoadOrder);

    [Fact]
    public void Resolve_ShadowedCopyListedFirst_StillResolvesTheLoadOrderCopy()
    {
        var session = SessionWith(
            Plugin("Shared.esp", "ModB", inLoadOrder: false),
            Plugin("Shared.esp", "ModA", inLoadOrder: true));

        Assert.Equal("ModA", PluginOriginResolver.Resolve(session, "Shared.esp"));
    }

    [Fact]
    public void Resolve_OnlyCopyIsOutsideTheLoadOrder_FallsBackRatherThanNamingIt()
    {
        // A write target that is not in the load order is not a legitimate target at all, so
        // resolving to its origin would attribute a pending change to a file the game never loads.
        // The reserved fallback keeps that impossible; the caller's own guards reject the edit.
        var session = SessionWith(Plugin("Orphan.esp", "SomeMod", inLoadOrder: false));

        Assert.Equal(PluginOrigin.DataDirectory, PluginOriginResolver.Resolve(session, "Orphan.esp"));
    }

    [Fact]
    public void Resolve_DisabledLoadOrderPlugin_ResolvesNormally()
    {
        // Participation is not membership: a disabled plugins.txt line is still in the load order
        // and is still a legitimate write target (#270 / ADR-0035).
        var disabled = Plugin("Disabled.esp", "SomeMod", inLoadOrder: true) with { Participates = false };
        var session = SessionWith(disabled);

        Assert.Equal("SomeMod", PluginOriginResolver.Resolve(session, "Disabled.esp"));
    }

    private sealed class StubGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public string DataFolderPath => throw new NotSupportedException();
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins { get; } = plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
