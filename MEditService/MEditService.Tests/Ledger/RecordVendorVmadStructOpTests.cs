using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #389 at <see cref="RecordVendor"/>'s own public seam (narrower than the API host, same style as
/// <see cref="RecordVendorApplyFieldsTests"/>): a VMAD struct-op payload (path -&gt; op object, not
/// path -&gt; plain value) vendors correctly when tagged with
/// <see cref="PendingChangeConstants.VmadStructOpChangeType"/> — the answer to the ticket's own
/// payload-mapping question is that <see cref="RecordVendor.ApplyFields"/> dispatches on
/// <c>ChangeType</c>, not on field-path shape, reusing <c>PluginWriter.TryApplyField</c>'s own
/// struct-op branch rather than transforming the payload.
/// </summary>
public class RecordVendorVmadStructOpTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (RecordVendor Vendor, LedgerRepository Ledger) MakeVendor(string ledgerRoot)
    {
        var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        return (new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance), ledger);
    }

    private static string WritePlugin(string originFolder, string pluginFileName, out string npcFormKey)
    {
        var pluginPath = Path.Combine(originFolder, pluginFileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("VendorNpc"); // no VMAD on the pristine record — first touch has none to preserve.
        mod.WriteToBinary(pluginPath);
        npcFormKey = npc.FormKey.ToString();
        return pluginPath;
    }

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    [Fact]
    public async Task FirstTouch_VmadStructOpAddScript_VendorsPristineWithoutScriptAndDirtWithScriptAttached()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-vendor-vmad-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-vendor-vmad-origin-").FullName;
        try
        {
            var (vendor, ledger) = MakeVendor(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var formKey);

            var fields = new Dictionary<string, JsonElement>
            {
                [@"VMAD\NewScript"] = J("""{"op":"add_script","name":"NewScript","flags":"Local","properties":[]}"""),
            };

            await vendor.VendorAndStageDirtAsync(
                originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
                fields, Schemas, GameRelease.Fallout4, PendingChangeConstants.VmadStructOpChangeType);

            var relativePath = LedgerRecordPath.For(pluginFileName, "npc_", formKey);
            var absolutePath = Path.Combine(originFolder, relativePath);
            var (gitDir, workTree) = ledger.PathsFor(originFolder);

            // Repo now exists and the record is tracked — the struct-op edit reached vendoring.
            Assert.True(ledger.IsTrackedAtHead(originFolder, relativePath));

            // Pristine (committed on main) has no script at all — it was vendored before the op applied.
            var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath.Replace('\\', '/')}");
            Assert.DoesNotContain("NewScript", committed, StringComparison.Ordinal);

            // Working-tree dirt carries the struct op's effect: the script attached.
            var dirt = await File.ReadAllTextAsync(absolutePath);
            Assert.Contains("NewScript", dirt, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
