using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class RespelledDataFolderTests
{
    [Fact]
    public void ALocalizedPlugin_IsNotReindexed_WhenTheDataFolderIsSpelledThroughASymlink()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("respelled-data-folder")
            .WithPlugin("A.esp", m =>
            {
                m.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, "The Big Door");
                m.UsingLocalization = true;
            })
            .Build();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        using var scratch = new ScratchDirectory("respelled-");
        var link = Path.Combine(scratch, "Data");
        Directory.CreateSymbolicLink(link, data.DataFolder);
        try
        {
            var respelled = data.Plugins.Select(p => p with { Path = p.Path.Replace(data.DataFolder, link, StringComparison.Ordinal) }).ToList();
            using var opens = new GatedPluginAdapter();
            using var warm = Indexes.Open(holder, opens);
            warm.Reconcile(holder, link, respelled, GameRelease.Fallout4, data.InstanceRoot);

            Assert.Empty(opens.Opened);
        }
        finally { Directory.Delete(link); }
    }
}
