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
        _holder.Apply(SnapshotPlugins.Snapshot(
            _data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins, [new PluginPlace(Mod, _folder, _folder)]));
    }

    public void Dispose() => _data.Dispose();

    private CreatePluginInModHandler Handler => TestEditService.PluginCreateInModHandler(_holder);

    [Fact]
    public async Task CreatePluginIn_AnEnabledModNamedInAnotherCase_WritesItInThatModsFolder()
    {
        var result = await Handler.CreatePluginIn(Mod.ToUpperInvariant(), "Second.esp", []);

        Assert.Equal(new PluginAddress("Second.esp", Mod), result.Created().Plugin);
        Assert.True(File.Exists(Path.Combine(_folder, "Second.esp")));
    }

    [Fact]
    public async Task CreatePluginIn_AnOriginThatIsNoPlaceOfTheLoadOrder_RefusesNamingItAndWritesNothing()
    {
        var result = (await Handler.CreatePluginIn("NoSuchMod", "Second.esp", [])).Refused();

        Assert.Equal(PluginCreateRefusal.OriginNotAMod, result.Refusal);
        Assert.Contains("NoSuchMod", result.Message, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_data.DataFolder, "Second.esp")));
    }
}
