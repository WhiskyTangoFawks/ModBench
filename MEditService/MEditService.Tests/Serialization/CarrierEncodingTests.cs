using System.Text;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.Serialization;

/// <summary><c>System.Text.Json</c>'s encoder escapes quotes, ampersands and non-ASCII where Newtonsoft
/// does not, so only text the two writers disagree about can expose it.</summary>
public sealed class CarrierEncodingTests
{
    // Every character class System.Text.Json's default encoder escapes and Newtonsoft does not.
    private const string AwkwardEditorId = "Bob's World & Co <tag> café";

    [Fact]
    public async Task AWorldspaceWhoseTextNeedsEscaping_IsNotReEncodedByGainingAnOrderedChildList()
    {
        var scratch = Directory.CreateTempSubdirectory("medit-carrier-encoding-").FullName;
        try
        {
            var mod = new Fallout4Mod(ModKey.FromFileName("Encoding.esp"), Fallout4Release.Fallout4);
            var worldspace = mod.Worldspaces.AddNew();
            worldspace.EditorID = AwkwardEditorId;
            // A block is a directory, so the worldspace's own document becomes a carrier.
            worldspace.SubCells.Add(new WorldspaceBlock { BlockNumberX = 1, BlockNumberY = -2 });

            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                mod, scratch, InlineWorkDropoff.Instance, CancellationToken.None);

            var worldspaceDirectory = Directory.EnumerateDirectories(Path.Combine(scratch, "Worldspaces")).Single();
            var carrier = SourceChildOrder.CarrierFor(worldspaceDirectory, parentIsRecord: true);
            var beforeSplice = await File.ReadAllTextAsync(carrier);

            SourceChildOrder.SpliceInto(scratch, mod);

            var afterSplice = await File.ReadAllTextAsync(carrier);

            // The document really did gain the list — otherwise this test proves nothing.
            Assert.Contains(SourceChildOrder.OrderMember, afterSplice, StringComparison.Ordinal);
            Assert.Single(SourceChildOrder.ListAt(carrier, nameof(Worldspace.SubCells)));

            // ...and every awkward character survived it verbatim, in the spelling the whole-mod
            // writer chose, with nothing escaped behind its back.
            Assert.Contains(AwkwardEditorId, afterSplice, StringComparison.Ordinal);
            Assert.DoesNotContain("\\u", afterSplice, StringComparison.Ordinal);

            // Nothing outside the added member changed: strip it back out and the bytes are the
            // document the whole-mod door wrote.
            Assert.Equal(WithoutOrderMember(beforeSplice), WithoutOrderMember(afterSplice));
        }
        finally
        {
            try { Directory.Delete(scratch, recursive: true); }
            catch (IOException) { /* scratch, best-effort */ }
        }
    }

    private static string WithoutOrderMember(string json)
    {
        var at = json.IndexOf($"\"{SourceChildOrder.OrderMember}\"", StringComparison.Ordinal);
        if (at < 0) return json.Trim();

        // The member is written last, so everything from the comma before it to the closing brace is
        // what it added.
        var comma = json.LastIndexOf(',', at);
        var builder = new StringBuilder(json[..comma]);
        builder.Append('\n').Append('}');
        return builder.ToString().Trim();
    }
}
