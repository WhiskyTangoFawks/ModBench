using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using Noggog;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class DeletedRecordDocumentTests
{
    private const string PluginName = "DeletedNpc.esp";
    private static readonly FormKey Npc = FormKey.Factory("000800:DeletedNpc.esp");

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static PluginDocument NpcDocumentOf(Action<string> write) => DocumentOf(Npc, write);

    private static PluginDocument DocumentOf(FormKey npc, Action<string> write)
    {
        using var directory = new ScratchDirectory("deleted-record-document-");
        var path = Path.Combine(directory.Path, PluginName);
        write(path);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), EmptyLoadOrder.Of(GameRelease.Fallout4), Schemas, PluginStrings.None).Answered();
        return documents.Records.Single(d => d.FormKey == npc.ToString());
    }

    [Theory]
    [InlineData("000800:DeletedNpc.esp")]
    [InlineData("000801:Master.esm", "Master.esm")]
    public void OpenDocuments_YieldsADeletedRecordWithNoSubrecordAsItsHeader_ItsOwnOrAnOverrideOfAMasters(string formKey, params string[] masters)
    {
        var npc = FormKey.Factory(formKey);

        var document = DocumentOf(npc, path => DeletedNpcPlugin.WriteEmpty(path, npc, [.. masters.Select(master => ModKey.FromFileName(master))]));

        Assert.Null(document.ParseDiagnosis);
    }

    [Fact]
    public void OpenDocuments_YieldsADeletedRecordThatStillHoldsFields_AsItsKeyAndEditorId_WithADiagnosisNamingIt()
    {
        var document = NpcDocumentOf(path => DeletedNpcPlugin.WriteHoldingFields(path, Npc));

        Assert.StartsWith("Npc 000800:DeletedNpc.esp (Guy) — ", document.ParseDiagnosis, StringComparison.Ordinal);
        Assert.Equal("{\n  \"FormKey\": \"000800:DeletedNpc.esp\",\n  \"EditorID\": \"Guy\"\n}", document.Text);
    }

    [Fact]
    public void OpenDocuments_YieldsADeletedOverrideOfALightMastersRecordWithNoSubrecordAsItsHeader()
    {
        using var directory = new ScratchDirectory("deleted-light-override-");
        var lightMaster = new StarfieldMod(ModKey.FromFileName("LightNpcs.esm"), StarfieldRelease.Starfield);
        lightMaster.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        var overridden = new FormKey(lightMaster.ModKey, 0x801);
        lightMaster.Npcs.Add(new Mutagen.Bethesda.Starfield.Npc(overridden, StarfieldRelease.Starfield) { EditorID = "Guy" });
        var masterPath = Path.Combine(directory.Path, lightMaster.ModKey.FileName);
        lightMaster.WriteToBinary(masterPath);

        var plugin = new StarfieldMod(ModKey.FromFileName(PluginName), StarfieldRelease.Starfield);
        plugin.ModHeader.MasterReferences.Add(new MasterReference { Master = lightMaster.ModKey });
        plugin.Npcs.Add(new Mutagen.Bethesda.Starfield.Npc(overridden, StarfieldRelease.Starfield) { MajorRecordFlagsRaw = 0x20 });
        var path = Path.Combine(directory.Path, PluginName);
        plugin.WriteToBinary(path, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.NoCheck,
            MasterFlagsLookup = new Cache<IModMasterStyledGetter, ModKey>(m => m.ModKey) { lightMaster },
        });
        var loadOrder = SnapshotPlugins.Snapshot(directory.Path, null, GameRelease.Starfield,
        [
            new LoadOrderEntry(lightMaster.ModKey.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, path, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ]);

        using var documents = Adapter.OpenDocuments(
            new ModPath(plugin.ModKey, path), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Answered();

        Assert.Null(documents.Records.Single(d => d.FormKey == overridden.ToString()).ParseDiagnosis);
    }
}
