using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>An edit of a record's FormID changes its FormKey and nothing else: the records that
/// reference it, itself included, are left as they are, and updating them is a script.</summary>
internal sealed class FormKeyChange(
    WriteTargets targets, RecordTextCodec codec, ILogger logger)
{
    /// <summary>The document member a record's FormID is, which the edit's path names.</summary>
    internal const string Member = RecordMembers.FormKey;

    /// <summary>Whether the envelope sets the record's FormID rather than a field of its document.</summary>
    internal static bool IsFormIdEdit(RecordEditEnvelope envelope) =>
        envelope is { Op: RecordEditEnvelope.Set, Path: [{ Kind: PathHop.MemberKind, Name: Member }] };

    /// <summary>A delete+create pair in source terms, written through a
    /// <see cref="SourceRepository.SourceTransaction"/> that restores the tree on failure.</summary>
    internal RecordEditResult Change(
        PluginAddress plugin, string formKey, WriteTargets.EditTarget editTarget,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, JsonElement? value)
    {
        var (_, identity, repository) = editTarget;
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return DocumentEdit.ReadOnlyRefusal(Member, Member, PluginHeader.FormIdReadOnly);
        }

        if (value is not { ValueKind: JsonValueKind.String } text
            || !FormKey.TryFactory(text.GetString(), out var requested))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, Member,
                $"{(value is { } given ? given.GetRawText() : "Nothing")} is not a FormKey. A FormID is written " +
                $"as its FormKey, the local ID in hex and then the plugin it is native to: 000800:{plugin.Name}.");
        }

        var parsedFormKey = FormKey.Factory(formKey);
        formKey = parsedFormKey.ToString();
        var requestedFormKey = requested.ToString();
        if (requestedFormKey == formKey) return RecordEditResult.Success();

        var originatingPlugin = parsedFormKey.ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.NotNativeRecord, Member,
                $"{formKey} is an override in {plugin.Name}: {originatingPlugin} is its master. " +
                $"Change its FormID in {originatingPlugin}, where the record is native.");
        }

        if (targets.ResolveTargetFormKey(repository, plugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget with { Path = Member };

        var transaction = new SourceRepository.SourceTransaction();
        if (SourceCommit.Write(transaction, repository, logger, $"Changing the FormID of {formKey} to {targetFormKey} failed.", () =>
            {
                transaction.Rekey(repository, plugin, identity, targetFormKey, schemas, codec);
                return null;
            }) is { } refused) return refused;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Changed the FormID of {OldFormKey} to {NewFormKey} in {Plugin} ({Origin})",
                formKey, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }
}
