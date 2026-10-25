using MEditService.Codec.Serialization;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

[Collection(CutDownPluginCollection.Name)]
public sealed class ContainerDocumentTests(CutDownPluginFixture fixture)
{
    private string? StoredBody(string formKey) =>
        fixture.Index.Queries.GetRenderedDocument(CutDownPluginFixture.Plugin, formKey).Value()?.Text;

    [Fact]
    public void AContainersStoredDocument_IsTheDocumentAnOwnFieldsCopyLands()
    {
        var setterMod = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
            GameRelease.Fallout4);
        IMajorRecordGetter[] containers =
        [
            setterMod.EnumerateMajorRecords<IQuest>().First(q => q.DialogTopics.Count > 0),
            setterMod.EnumerateMajorRecords<ICell>().First(c => c.Temporary.Count > 0 && c.NavigationMeshes.Count > 0),
        ];

        Assert.All(containers, container =>
        {
            var recordType = RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(container);
            var ownFieldsCopy = ContainerDocumentEdits.WithoutChildren(
                RecordTextCodec.SerializeToText(container, GameRelease.Fallout4), GameRelease.Fallout4, recordType);

            Assert.Equal(ownFieldsCopy, StoredBody(container.FormKey.ToString()));
        });
    }
}
