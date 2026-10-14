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
        TestEditService.PluginCreateHandler(_holder).CreatePlugin(new PluginAddress("First.esp", Mod), _folder, _folder).GetAwaiter().GetResult();
        _holder.Apply(SnapshotPlugins.Snapshot(_data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4,
        [
            .. _data.Plugins,
            new LoadOrderEntry("First.esp", Path.Combine(_folder, "First.esp"), Mod, Line: 1, Enabled: true, Winning: true),
        ]));
    }

    public void Dispose() => _data.Dispose();

    private CreatePluginInModHandler Handler => TestEditService.PluginCreateInModHandler(_holder);

    [Fact]
    public async Task CreatePluginIn_AModTheLoadOrderHoldsAPluginOf_WritesItInThatModsFolderAndMarksTheWrite()
    {
        var awaited = _holder.ArrivalAwaited;

        var result = await Handler.CreatePluginIn(Mod.ToUpperInvariant(), "Second.esp");

        Assert.Null(result.Refusal);
        Assert.Equal(new PluginAddress("Second.esp", Mod), result.Created);
        Assert.True(File.Exists(Path.Combine(_folder, "Second.esp")));
        Assert.True(_holder.ArrivalAwaited > awaited);
    }

    [Fact]
    public async Task CreatePluginIn_ThatRefuses_MarksNothing()
    {
        var awaited = _holder.ArrivalAwaited;

        var result = await Handler.CreatePluginIn(Mod, "First.esp");

        Assert.Equal(PluginCreateRefusal.FileExists, result.Refusal);
        Assert.Equal(awaited, _holder.ArrivalAwaited);
    }

    [Theory]
    [InlineData("NoSuchMod")]
    [InlineData(PluginOrigin.Overwrite)]
    [InlineData(PluginOrigin.DataDirectory)]
    public async Task CreatePluginIn_AnOriginThatIsNotAModTheLoadOrderHoldsAPluginOf_RefusesNamingItAndWritesNothing(string origin)
    {
        var awaited = _holder.ArrivalAwaited;

        var result = await Handler.CreatePluginIn(origin, "Second.esp");

        Assert.Equal(PluginCreateRefusal.OriginNotAMod, result.Refusal);
        Assert.Contains(origin, result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_data.DataFolder, "Second.esp")));
        Assert.Equal(awaited, _holder.ArrivalAwaited);
    }
}
