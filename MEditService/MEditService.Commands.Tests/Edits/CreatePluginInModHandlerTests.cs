using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class CreatePluginInModHandlerTests : IDisposable
{
    private const string Mod = "OriginMod";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("create-plugin-in-mod-handler")
        .WithPlugin("Base.esp")
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly string _folder;

    public CreatePluginInModHandlerTests()
    {
        _folder = Directory.CreateDirectory(Path.Combine(_data.DataFolder, Mod)).FullName;
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins));
        TestEditService.PluginCreateHandler(_holder).CreatePlugin(new PluginAddress("First.esp", Mod), _folder, _folder, []).GetAwaiter().GetResult();
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. _data.Plugins,
            new LoadOrderEntry("First.esp", Path.Combine(_folder, "First.esp"), Mod, Line: 1, Enabled: true, Winning: true),
        ], [new PluginPlace(Mod, _folder, _folder)]));
    }

    public void Dispose() => _data.Dispose();

    private readonly HandedWrites _index = HandedWrites.Create();

    private CreatePluginInModHandler Handler => TestEditService.PluginCreateInModHandler(_holder, _index.Queries);

    [Fact]
    public async Task CreatePluginIn_AModTheLoadOrderHoldsAPluginOf_WritesItInThatModsFolder_AndHandsTheRecordIndexNothing()
    {
        var result = await Handler.CreatePluginIn(Mod.ToUpperInvariant(), "Second.esp", []);

        Assert.Equal(new PluginAddress("Second.esp", Mod), result.Created().Plugin);
        Assert.True(File.Exists(Path.Combine(_folder, "Second.esp")));
        Assert.Empty(_index.Hands);
    }

    [Theory]
    [InlineData("NoSuchMod")]
    public async Task CreatePluginIn_AnOriginThatIsNoPlaceOfTheLoadOrder_RefusesNamingItAndWritesNothing(string origin)
    {
        var result = (await Handler.CreatePluginIn(origin, "Second.esp", [])).Refused();

        Assert.Equal(PluginCreateRefusal.OriginNotAMod, result.Refusal);
        Assert.Contains(origin, result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_data.DataFolder, "Second.esp")));
        Assert.Empty(_index.Hands);
    }
}
