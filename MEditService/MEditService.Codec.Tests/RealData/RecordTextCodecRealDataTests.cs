using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.RealData;

public class RecordTextCodecRealDataTests
{
    private const string AffectedWeaponEditorId = "VRWorkshopShared_AlienBlaster_NonPlayable";

    private static readonly ModPath Plugin = new(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath);

    private static IFallout4ModGetter DeepParsed() => (IFallout4ModGetter)ModFactory.ImportSetter(Plugin, GameRelease.Fallout4);

    private static JsonElement DocumentOf(IMajorRecordGetter record)
    {
        using var document = JsonDocument.Parse(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4));
        return document.RootElement.Clone();
    }

    private static string? LeafOf(JsonElement union) => union.GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString();

    [Fact]
    public void OverlayAndDeepParse_SerializeToIdenticalText_OnARealWeaponWhoseObjectTemplatesTheOverlayMustNotSplit()
    {
        using var overlayImport = ModFactory.ImportGetter(Plugin, GameRelease.Fallout4);
        var overlayWeapon = ((IFallout4ModGetter)overlayImport).Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
        var deepParsedWeapon = DeepParsed().Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
        Assert.NotEmpty(deepParsedWeapon.ObjectTemplates.Require());
        Assert.Equal(deepParsedWeapon.ObjectTemplates.Require().Count, overlayWeapon.ObjectTemplates?.Count);

        var deepParsedText = RecordTextCodec.SerializeToText(deepParsedWeapon, GameRelease.Fallout4);

        Assert.Equal(deepParsedText, RecordTextCodec.SerializeToText(overlayWeapon, GameRelease.Fallout4));
        Assert.Equal(deepParsedText, RecordTextCodec.RoundTrip(deepParsedText, GameRelease.Fallout4, "weap"));
    }

    [Fact]
    public async Task ARealWeapon_ReadsBackFieldFaithful()
    {
        var deepParsed = DeepParsed();
        var weapon = deepParsed.Weapons.Single(w => w.EditorID == AffectedWeaponEditorId);
        var mod = new Fallout4Mod(deepParsed.ModKey, Fallout4Release.Fallout4);
        mod.Weapons.Add(weapon.DeepCopy());

        var readBack = await ReadBack.ThroughTheWholeModDoor<IWeaponGetter>(mod, weapon);

        var leaves = MaskInspector.Leaves(weapon.GetEqualsMask(readBack)).ToList();
        Assert.NotEmpty(leaves);
        Assert.Empty(leaves.Where(l => !l.Value).Select(l => l.Path));
    }

    [Fact]
    public void EveryRecordOfTheRealPlugin_AndItsHeader_ReadBackToTheTextTheCodecWroteForThem()
    {
        var mod = DeepParsed();
        var types = RecordTypes.For(GameRelease.Fallout4);
        var records = mod.EnumerateMajorRecords().ToList();
        Assert.True(records.Count > 3000, $"Expected the whole cut-down plugin to be read; got {records.Count} records.");

        var header = Encoding.UTF8.GetString(HeaderDocument.Write(mod));
        var divergent = records
            .Select(record => (Where: $"{types.RecordTypeOf(record)} {record.FormKey}", Text: RecordTextCodec.SerializeToText(record, GameRelease.Fallout4), RecordType: types.RecordTypeOf(record)))
            .Select(written => (written.Where, written.Text, Read: RecordTextCodec.RoundTrip(written.Text, GameRelease.Fallout4, written.RecordType)))
            .Append((Where: "header", Text: header, Read: Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(header), GameRelease.Fallout4)))))
            .Where(round => round.Read != round.Text)
            .Select(round => $"{round.Where}: {Golden.FirstDifference(round.Text, round.Read)}")
            .ToList();

        Assert.Empty(divergent);
    }

    [Fact]
    public void EveryRealNpcsLevel_IsWrittenNamingItsLeaf()
    {
        var leaves = DeepParsed().Npcs.Select(npc => LeafOf(DocumentOf(npc).GetProperty("Level"))).Distinct().ToList();

        Assert.Equal([nameof(NpcLevel)], leaves);
    }

    [Fact]
    public void ARealQuestsAliases_AreWrittenEachNamingItsLeaf()
    {
        var quest = DeepParsed().Quests.Single(q => q.EditorID == "DialogueConcordArea");

        var leaves = DocumentOf(quest).GetProperty("Aliases").EnumerateArray().Select(LeafOf).ToHashSet();

        Assert.Contains(nameof(QuestReferenceAlias), leaves);
        Assert.Contains(nameof(QuestLocationAlias), leaves);
    }

    [Fact]
    public void ARealRecordsScripts_AreWrittenInItsAdapter()
    {
        var record = DeepParsed().EnumerateMajorRecords().Single(r => r.FormKey == FormKey.Factory("2499C4:Fallout4.esm"));

        var scripts = DocumentOf(record).GetProperty("VirtualMachineAdapter").GetProperty("Scripts").EnumerateArray().Select(s => s.GetProperty("Name").GetString()).ToList();

        Assert.Equal(2, scripts.Count);
        Assert.Contains("RadroachLegendaryScript", scripts);
    }
}
