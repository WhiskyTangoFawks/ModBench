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
        ], [new PluginPlace(Mod, _folder, _folder)]));
    }

    private void Place(PluginPlace place)
    {
        var held = _holder.Current;
        _holder.Apply(new LoadOrderSnapshot(
            held.DataFolderPath, held.InstanceRoot, held.GameRelease, held.Plugins, [], [], [], [], [.. held.Places, place], held.StringsLanguage));
    }

    public void Dispose() => _data.Dispose();

    private CreatePluginInModHandler Handler => TestEditService.PluginCreateInModHandler(_holder);

    [Fact]
    public async Task CreatePluginIn_AModTheLoadOrderHoldsAPluginOf_WritesItInThatModsFolderAndMarksTheWrite()
    {
        var awaited = _holder.ArrivalAwaited;

        var result = await Handler.CreatePluginIn(Mod.ToUpperInvariant(), "Second.esp");

        Assert.Equal(new PluginAddress("Second.esp", Mod), result.Created());
        Assert.True(File.Exists(Path.Combine(_folder, "Second.esp")));
        Assert.True(_holder.ArrivalAwaited > awaited);
    }

    [Fact]
    public async Task CreatePluginIn_APlaceTheLoadOrderHoldsNoPluginOf_WritesItInThatPlacesFolder()
    {
        var emptyFolder = Directory.CreateDirectory(Path.Combine(_data.DataFolder, "EmptyMod")).FullName;
        Place(new PluginPlace("EmptyMod", emptyFolder, null));

        var result = await Handler.CreatePluginIn("EmptyMod", "Patch.esp");

        result.Created();
        Assert.True(File.Exists(Path.Combine(emptyFolder, "Patch.esp")));
    }

    [Fact]
    public async Task CreatePluginIn_Overwrite_WritesItInOverwritesFolder()
    {
        var overwrite = Directory.CreateDirectory(Path.Combine(_data.DataFolder, "overwrite")).FullName;
        Place(new PluginPlace(LoadOrderEntry.OverwriteOrigin, overwrite, null));

        var result = await Handler.CreatePluginIn(LoadOrderEntry.OverwriteOrigin, "Patch.esp");

        Assert.Equal(new PluginAddress("Patch.esp", LoadOrderEntry.OverwriteOrigin), result.Created());
        Assert.True(File.Exists(Path.Combine(overwrite, "Patch.esp")));
    }

    [Fact]
    public async Task CreatePluginIn_ThatRefuses_MarksNothing()
    {
        var awaited = _holder.ArrivalAwaited;

        var result = (await Handler.CreatePluginIn(Mod, "First.esp")).Refused();

        Assert.Equal(PluginCreateRefusal.FileExists, result.Refusal);
        Assert.Equal(awaited, _holder.ArrivalAwaited);
    }

    [Theory]
    [InlineData("NoSuchMod")]
    [InlineData(PluginOrigin.DataDirectory)]
    public async Task CreatePluginIn_AnOriginThatIsNoPlaceOfTheLoadOrder_RefusesNamingItAndWritesNothing(string origin)
    {
        var awaited = _holder.ArrivalAwaited;

        var result = (await Handler.CreatePluginIn(origin, "Second.esp")).Refused();

        Assert.Equal(PluginCreateRefusal.OriginNotAMod, result.Refusal);
        Assert.Contains(origin, result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_data.DataFolder, "Second.esp")));
        Assert.Equal(awaited, _holder.ArrivalAwaited);
    }
}
