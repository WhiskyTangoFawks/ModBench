using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class LightRangeProblemTests : IDisposable
{
    private const string Light = "Light.esp";
    private const uint OutsideTheRange = 0x1000;

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _light;
    private readonly string _outside;

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
            .Tracked();
        _light = _fixture.Plugins.Single();
        _outside = outside.ToString();
        var header = Directory.EnumerateFiles(Path.Combine(_light.ModFolderOf(), PluginSourceRoot.For(Light)), "*.json").Single();
        File.WriteAllText(header, File.ReadAllText(header).Replace("\"ModHeader\": {", "\"ModHeader\": {\n    \"Flags\": [\"Small\"],", StringComparison.Ordinal));
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ARecordOutsideTheLightRange_IsAProblemOnItsFile_AndOnlyItsFile()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);

        var problem = Assert.Single(index.Queries.GetProblems().Value().Single().Problems);
        Assert.Equal(Path.GetRelativePath(_light.ModFolderOf(), _light.SourceFileOf(index.DocumentOf(_outside, _light.KeyOf()))), problem.SourceRelativePath);
        Assert.Contains("light range", problem.Message, StringComparison.Ordinal);
        Assert.Contains(_outside, problem.Message, StringComparison.Ordinal);
    }
}
