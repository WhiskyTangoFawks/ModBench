using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class DeletedRecordDocumentTests
{
    private const string PluginName = "DeletedNpc.esp";
    private static readonly FormKey Npc = FormKey.Factory("000800:DeletedNpc.esp");

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static PluginDocument NpcDocumentOf(Action<string> write)
    {
        using var directory = new ScratchDirectory("deleted-record-document-");
        var path = Path.Combine(directory.Path, PluginName);
        write(path);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas).Answered();
        return documents.Records.Single(d => d.FormKey == Npc.ToString());
    }

    [Fact]
    public void OpenDocuments_YieldsADeletedRecordWithNoSubrecordAsItsHeader()
    {
        var document = NpcDocumentOf(path => DeletedNpcPlugin.WriteEmpty(path, Npc));

        Assert.Null(document.ParseDiagnosis);
    }

    [Fact]
    public void OpenDocuments_YieldsADeletedRecordThatStillHoldsFieldsAsItsDiagnosis()
    {
        var document = NpcDocumentOf(path => DeletedNpcPlugin.WriteHoldingFields(path, Npc));

        Assert.NotNull(document.ParseDiagnosis);
    }
}
