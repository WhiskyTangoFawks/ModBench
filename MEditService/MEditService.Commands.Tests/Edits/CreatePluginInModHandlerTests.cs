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
    public async Task CreatePluginIn_AModTheLoadOrderHoldsNoPluginOf_WritesItInThatModsFolder()
    {
        var emptyFolder = Directory.CreateDirectory(Path.Combine(_data.DataFolder, "EmptyMod")).FullName;
        var held = _holder.Current;
        _holder.Apply(new LoadOrderSnapshot(
            held.DataFolderPath, held.InstanceRoot, held.GameRelease, held.Plugins, [], [], [], [],
            [new PluginProvider.FromMod("EmptyMod", emptyFolder, null)]));

        var result = await Handler.CreatePluginIn("EmptyMod", "Patch.esp");

        Assert.Null(result.Refusal);
        Assert.True(File.Exists(Path.Combine(emptyFolder, "Patch.esp")));
    }

    [Fact]
    public async Task CreatePluginIn_ASourceModTheLoadOrderHoldsNoPluginOf_LandsItsSourceInTheSourceFolderTheSnapshotNamed()
    {
        var tracked = await TestEditService.InitHandler(_holder).InitAsync(ToInit.In(_holder.Held?.Snapshot, Mod));
        Assert.Single(tracked.Landed);
        File.Delete(Path.Combine(_folder, "First.esp"));
        var held = _holder.Current;
        _holder.Apply(new LoadOrderSnapshot(
            held.DataFolderPath, held.InstanceRoot, held.GameRelease, SnapshotPlugins.Of(_data.Plugins), [], [], [], [],
            [new PluginProvider.FromMod(Mod, _folder, _folder)]));

        var result = await Handler.CreatePluginIn(Mod, "Patch.esp");

        Assert.Null(result.Refusal);
        var patch = new RegisteredPlugin("Patch.esp", Mod, Path.Combine(_folder, "Patch.esp"), new PluginProvider.FromMod(Mod, _folder, _folder), Line: null, PluginStrings.None);
        Assert.True(TestAdapters.Source().SourceReads(patch));
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
    public async Task CreatePluginIn_AnOriginThatIsNotAModOfTheLoadOrder_RefusesNamingItAndWritesNothing(string origin)
    {
        var awaited = _holder.ArrivalAwaited;

        var result = await Handler.CreatePluginIn(origin, "Second.esp");

        Assert.Equal(PluginCreateRefusal.OriginNotAMod, result.Refusal);
        Assert.Contains(origin, result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_data.DataFolder, "Second.esp")));
        Assert.Equal(awaited, _holder.ArrivalAwaited);
    }
}
