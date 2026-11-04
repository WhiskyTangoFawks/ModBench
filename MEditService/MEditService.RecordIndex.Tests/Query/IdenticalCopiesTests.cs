using System.Drawing;
using System.Text.Json.Nodes;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class IdenticalCopiesTests
{
    private static readonly PluginAddress MasterPlugin = new("Master.esp", "MasterMod");
    private static readonly PluginAddress CopyPlugin = new("Copy.esp", "CopyMod");
    private static readonly ModKey Master = ModKey.FromFileName(MasterPlugin.Name);
    private static readonly FormKey Record = new(Master, 0x800);
    private static readonly FormKey A = new(Master, 0x900);
    private static readonly FormKey B = new(Master, 0x901);
    private static readonly FormKey Template = new(Master, 0x902);
    private const int PartialFormBit = 0x4000;

    private sealed record Copies(Func<IFallout4MajorRecord> Master, Action<IFallout4MajorRecord> Changed, Action<JsonObject>? Spelled = null);

    private static MiscItem Item() => new(Record, Fallout4Release.Fallout4) { EditorID = "Item", Name = "Item" };

    private static Faction RelatedTo(params FormKey[] targets) => new(Record, Fallout4Release.Fallout4)
    {
        EditorID = "Faction",
        Relations = [.. targets.Select((target, at) => new Relation { Target = new FormLink<IRelatableGetter>(target), Modifier = at + 1 })],
    };

    private static Npc TemplatedNpc()
    {
        var npc = new Npc(Record, Fallout4Release.Fallout4) { EditorID = "Templated", UseTemplateActors = Npc.TemplateActorType.Traits };
        npc.DefaultTemplate.SetTo(Template);
        npc.Race.SetTo(A);
        return npc;
    }

    private static Cell PartialCell() => new(Record, Fallout4Release.Fallout4)
    {
        EditorID = "Partial",
        WaterHeight = 100f,
        MajorRecordFlagsRaw = PartialFormBit,
    };

    private static readonly Dictionary<string, (Copies Copies, bool Identical)> Cases = new()
    {
        ["a copy that differs only in its version stamps"] = (new(Item, copy =>
        {
            copy.FormVersion = 120;
            copy.VersionControl = 0x1234;
            ((Fallout4MajorRecord)copy).Version2 = 7;
        }), true),
        ["a copy that changes a value"] = (new(Item, copy => ((MiscItem)copy).Name = "Renamed"), false),
        ["a copy holding a keyed array in another order"] = (new(
            () => RelatedTo(A, B),
            copy => ((Faction)copy).Relations.Reverse()), true),
        ["a copy whose colour holding no alpha is spelled with one"] = (new(
            () => new Weather(Record, Fallout4Release.Fallout4) { EditorID = "Weather", LightningColor = Color.FromArgb(0, 0x10, 0x20, 0x30) },
            _ => { },
            document => document["LightningColor"] = "#7F102030"), true),
        ["a copy spelling a member its master omits for its default"] = (new(Item, _ => { }, document => document["Value"] = 0), true),
        ["a copy that changes a field it hands to its template"] = (new(TemplatedNpc, copy => ((Npc)copy).Race.SetTo(B)), true),
        ["a Partial Form copy that changes its own field"] = (new(PartialCell, copy => ((Cell)copy).WaterHeight = 5f), true),
    };

    public static TheoryData<string> CaseNames => [.. Cases.Keys];

    private static ScatteredFixtureData Fixture(Copies copies, bool copyActive = true) =>
        new PluginFixtureBuilder("medit-identical-copies")
            .WithPlugin(MasterPlugin.Name, mod => Hold(mod, copies.Master()), origin: MasterPlugin.Origin)
            .WithPlugin(CopyPlugin.Name, (mod, built) =>
            {
                var copy = (IFallout4MajorRecord)built[0].EnumerateMajorRecords().Single(r => r.FormKey == Record).DeepCopy();
                copies.Changed(copy);
                Hold(mod, copy);
            }, enabled: copyActive, origin: CopyPlugin.Origin)
            .BuildScattered();

    private static void Hold(Fallout4Mod mod, IFallout4MajorRecord record)
    {
        switch (record)
        {
            case Cell cell: mod.AddInteriorCells(cell); break;
            case MiscItem item: mod.MiscItems.Add(item); break;
            case Weather weather: ((IMod)mod).GetTopLevelGroup<Weather>().Set(weather); break;
            case Npc npc: mod.Npcs.Add(npc); break;
            case Faction faction: mod.Factions.Add(faction); break;
            default: throw new ArgumentException($"No group here holds a {record.GetType().Name}.", nameof(record));
        }
    }

    private static Dictionary<PluginAddress, string?> HashesBy(OpenedIndex index) =>
        index.Queries.SelectRows(
                $"SELECT plugin, origin, conflict_hash(record_type, body, parse_diagnosis) AS conflict_hash FROM records WHERE form_key = '{Record}'")
            .Value().Rows
            .ToDictionary(
                row => new PluginAddress(row.GetProperty("plugin").GetString() ?? "", row.GetProperty("origin").GetString() ?? ""),
                row => row.GetProperty("conflict_hash").GetString(),
                PluginAddress.Comparer);

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CopiesHashAlike_ExactlyWhereTheClassifierFindsTheCopyIdenticalToItsMaster(string name)
    {
        var (copies, identical) = Cases[name];
        using var plugins = Fixture(copies);
        if (copies.Spelled is not null) SourceMods.Init(plugins.Plugins.Single(p => p.Name == CopyPlugin.Name));
        using var index = Indexes.Reconciled(plugins);
        if (copies.Spelled is { } spelled)
        {
            var document = (JsonNode.Parse(index.BodyOf(Record.ToString(), CopyPlugin)) as JsonObject).Require();
            spelled(document);
            index.Project(plugins.Plugins.Single(p => p.Name == CopyPlugin.Name), [(Record.ToString(), document.ToJsonString())]);
        }

        var hashes = HashesBy(index);
        var verdict = index.StackOf(Record.ToString()).Single(copy => copy.Plugin == CopyPlugin.Name).ConflictThis;

        Assert.Equal(
            (identical, identical),
            (verdict == ConflictThis.IdenticalToMaster, hashes[MasterPlugin] is { } master && master == hashes[CopyPlugin]));
    }

    [Fact]
    public void ACopyInAPluginThatIsNotActive_HashesAsAnActiveCopyDoes()
    {
        using var plugins = Fixture(new(Item, copy => copy.VersionControl = 0x1234), copyActive: false);
        using var index = Indexes.Reconciled(plugins);

        var hashes = HashesBy(index);

        Assert.Equal(hashes[MasterPlugin], hashes[CopyPlugin]);
    }

    [Fact]
    public void CopiesTheCodecRefused_HashNothing_ThoughTheirStubsMatch()
    {
        using var plugins = Fixture(new(Item, copy => ((MiscItem)copy).Name = "Renamed"));
        using var index = Indexes.Reconciled(plugins, adapter: new DiagnosingAdapter { Unreadable = Record.ToString() });

        Assert.All(HashesBy(index).Values, Assert.Null);
    }
}
