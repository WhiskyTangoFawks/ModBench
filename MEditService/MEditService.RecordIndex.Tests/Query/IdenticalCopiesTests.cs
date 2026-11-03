using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class IdenticalCopiesTests
{
    private static readonly ModKey Master = ModKey.FromFileName("Master.esp");
    private static readonly FormKey Item = new(Master, 0x800);

    private static Action<Fallout4Mod> Copy(string name, ushort formVersion = 131, uint versionControl = 0, ushort version2 = 0) => mod =>
        mod.MiscItems.Add(new MiscItem(Item, Fallout4Release.Fallout4)
        {
            EditorID = "Item",
            Name = name,
            FormVersion = formVersion,
            VersionControl = versionControl,
            Version2 = version2,
        });

    private static Dictionary<string, string?> HashesBy(OpenedIndex index) =>
        index.Queries.SelectRows($"SELECT plugin, compared_hash FROM records WHERE form_key = '{Item}'").Value().Rows
            .ToDictionary(row => row.GetProperty("plugin").GetString() ?? "", row => row.GetProperty("compared_hash").GetString());

    [Fact]
    public void CopiesThatDifferOnlyInTheirVersionStamps_HashTheSame()
    {
        using var plugins = new PluginFixtureBuilder("medit-identical-copies")
            .WithPlugin(Master.FileName, Copy("Item"))
            .WithPlugin("Stamped.esp", Copy("Item", formVersion: 120, versionControl: 0x1234, version2: 7))
            .Build();
        using var index = Indexes.Reconciled(plugins);

        var hashes = HashesBy(index);

        Assert.NotNull(hashes[Master.FileName]);
        Assert.Equal(hashes[Master.FileName], hashes["Stamped.esp"]);
    }

    [Fact]
    public void ACopyThatChangesAValue_HashesOtherwise()
    {
        using var plugins = new PluginFixtureBuilder("medit-identical-copies")
            .WithPlugin(Master.FileName, Copy("Item"))
            .WithPlugin("Renamed.esp", Copy("Renamed"))
            .Build();
        using var index = Indexes.Reconciled(plugins);

        var hashes = HashesBy(index);

        Assert.NotEqual(hashes[Master.FileName], hashes["Renamed.esp"]);
    }

    [Fact]
    public void ACopyInAPluginThatIsNotActive_HashesAsAnActiveCopyDoes()
    {
        using var plugins = new PluginFixtureBuilder("medit-identical-copies")
            .WithPlugin(Master.FileName, Copy("Item"))
            .WithPlugin("Inactive.esp", Copy("Item", versionControl: 0x1234), enabled: false)
            .Build();
        using var index = Indexes.Reconciled(plugins);

        var hashes = HashesBy(index);

        Assert.Equal(hashes[Master.FileName], hashes["Inactive.esp"]);
    }

    [Fact]
    public void CopiesTheCodecCouldNotRead_HashNothing()
    {
        using var plugins = new PluginFixtureBuilder("medit-identical-copies")
            .WithPlugin(Master.FileName, Copy("Item"))
            .WithPlugin("Unreadable.esp", Copy("Renamed"))
            .Build();
        using var index = Indexes.Reconciled(plugins, adapter: new DiagnosingAdapter { Unreadable = Item.ToString() });

        Assert.All(HashesBy(index).Values, Assert.Null);
    }
}
