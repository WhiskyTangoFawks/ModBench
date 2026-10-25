using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class LightRangeProblemTests : IDisposable
{
    private const string Light = "Light.esp";
    private const uint OutsideTheRange = 0x1000;
    private const string ModHeaderOpening = "\"ModHeader\": {";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _light;
    private readonly string _outside;
    private readonly InMemoryNotificationPublisher _notifications = new();

    public LightRangeProblemTests()
    {
        FormKey outside = default;
        _fixture = new PluginFixtureBuilder("light-range")
            .WithPlugin(Light, mod =>
            {
                _ = mod.Npcs.AddNew("InRange");
                outside = new FormKey(mod.ModKey, OutsideTheRange);
                mod.Npcs.Add(new Npc(outside, Fallout4Release.Fallout4) { EditorID = "OutOfRange" });
            }, origin: "LightMod")
            .BuildScattered()
            .CompiledPlugin();
        _light = _fixture.Plugins.Single();
        _outside = outside.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    private string HeaderFile => Directory.EnumerateFiles(Path.Combine(_light.ModFolderOf(), PluginSourceRoot.For(Light)), "*.json").Single();

    private string HeaderFlaggedLight => File.ReadAllText(HeaderFile).Replace(ModHeaderOpening, ModHeaderOpening + "\n    \"Flags\": [\"Small\"],", StringComparison.Ordinal);

    private static IReadOnlyList<RecordIndex.Queries.SourceProblem> Problems(OpenedIndex index) => index.Queries.GetProblems().Value().Single().Problems;

    private string OutsideFile(OpenedIndex index) =>
        Path.GetRelativePath(_light.ModFolderOf(), _light.SourceFileOf(index.DocumentOf(_outside, _light.Key)));

    [Fact]
    public void AHeaderTypedLight_IsAProblemOnTheRecordsFile_UntilItIsTypedOut_AndThePluginStaysItsSource()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, notifications: _notifications);
        Assert.Empty(Problems(index));

        var before = _notifications.Notifications.Count;
        index.Unsaved.Apply([new DocumentChange(HeaderFile, HeaderFlaggedLight)]);
        Waits.Reached(() => _notifications.Since(before).Any(n => PluginChanged(_light)(n)), "the problem announced");

        Assert.Equal(OutsideFile(index), Assert.Single(Problems(index)).SourceRelativePath);
        Assert.True(index.ReadFromItsPluginSource(_light.Key));

        before = _notifications.Notifications.Count;
        index.Unsaved.Apply([]);
        Waits.Reached(() => _notifications.Since(before).Any(n => PluginChanged(_light)(n)), "the problem cleared");

        Assert.Empty(Problems(index));
    }
}
