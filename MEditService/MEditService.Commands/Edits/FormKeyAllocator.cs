using System.Globalization;
using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.Commands.Edits;

/// <summary>The one place a new FormKey is drawn (plugins.md, Create record, stories 2 and 3). One gesture
/// draws all its keys from one allocator.</summary>
internal sealed class FormKeyAllocator
{
    private readonly PluginAddress _plugin;
    private readonly bool _headed;
    private readonly FormIdLimit? _limit;
    private readonly IReadOnlySet<string> _used;
    private uint _next;

    private FormKeyAllocator(
        PluginAddress plugin, GameRelease release, SourceDocument? header, IReadOnlySet<string> used)
    {
        (_plugin, _used, _headed) = (plugin, used, header is not null);
        // The working tree's header document decides (ADR-0007), so a flag flipped this session caps
        // minting immediately.
        _limit = header is null ? null : PluginFlags.LimitOf(HeaderDocument.Read(Encoding.UTF8.GetBytes(header.Body), release), plugin.Name);
        var highest = used.Where(IsNative).Select(LocalId).DefaultIfEmpty(0u).Max();
        _next = Math.Max(highest + 1, GameConstants.Get(release).DefaultHighRangeFormID);
    }

    internal static Answer<FormKeyAllocator, SourceFailure> Over(ISourceRepository repository, PluginAddress plugin, GameRelease release) =>
        repository.RecordOf(plugin, PluginHeader.IdentityOf(plugin.Name)).Then(header =>
            repository.FormKeysUsed(plugin).Then(used => SourceAnswer.Of(new FormKeyAllocator(plugin, release, header, used))));

    /// <summary>The FormKey after the highest of the plugin's own records, and after every one drawn before it.
    /// Non-null is the refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Next(out string formKey)
    {
        formKey = "";
        if (RefuseWithoutHeader() is { } headerless) return headerless;
        if (_next > Cap) return RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, ExhaustedMessage());

        formKey = KeyOf(_next++);
        return null;
    }

    /// <summary>A FormKey the user asked for, which must be native, in range and free. Non-null is the
    /// refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Claim(string requestedFormKey, out string formKey)
    {
        formKey = "";
        if (RefuseWithoutHeader() is { } headerless) return headerless;
        if (RefuseIfNotNativeTarget(requestedFormKey) is { } notNative) return notNative;
        if (_used.Contains(requestedFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{requestedFormKey} is already held by a record in {_plugin.Name}.");
        }

        formKey = requestedFormKey;
        return null;
    }

    private RecordEditResult? RefuseWithoutHeader() =>
        _headed
            ? null
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginSourceUnreadable,
                $"{_plugin.Name} ({_plugin.Origin}) has no header document, so its FormID limit is unknown. " +
                "Check the Source Control panel.");

    private uint Cap => _limit?.Max ?? FormID.FullIdMask;

    private static string Lift(FormIdLimit limit) => (limit.ByFlag, limit.ByExtension) switch
    {
        (true, true) => $"clear the {limit.Flag} flag and rename the plugin off .esl",
        (false, true) => "rename the plugin off .esl",
        _ => $"clear the {limit.Flag} flag",
    };

    private string KeyOf(uint id) => $"{id:X6}:{_plugin.Name}";

    private bool IsNative(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed)
        && parsed.ModKey.FileName.String.Equals(_plugin.Name, StringComparison.OrdinalIgnoreCase);

    // A foreign ModKey would land a record inside this plugin's tree while claiming another origin,
    // indistinguishable from a corrupt override; xEdit never offers one either. Range is checked
    // after ownership.
    private RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey)
    {
        var parsed = FormKey.Factory(requestedFormKey);
        if (!IsNative(requestedFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{requestedFormKey} belongs to {parsed.ModKey.FileName.String}, not {_plugin.Name} — a requested FormKey " +
                "must be native to the plugin that is to hold it.");
        }

        if (_limit is not { } limit) return null;
        if (parsed.ID > limit.Max)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormIdOutsideFlagLimit,
                $"{requestedFormKey} exceeds {_plugin.Name}'s {limit.Flag} local FormID range — a {limit.Flag} " +
                $"plugin can only address local FormIDs up to 0x{limit.Max:X}. " +
                $"Choose a FormID within that range, or {Lift(limit)}.");
        }

        return parsed.ID < limit.Min
            ? RecordEditResult.Refused(
                RecordEditRefusal.FormIdOutsideFlagLimit,
                $"{requestedFormKey} is below {_plugin.Name}'s {limit.Flag} local FormID range, 0x{limit.Min:X}-0x{limit.Max:X}. " +
                "Choose a FormID within that range.")
            : null;
    }

    private string ExhaustedMessage()
    {
        var noneFree = $"{_plugin.Name} has no FormKey free after the highest of its own records";
        if (_limit is not { } limit) return $"{noneFree}, up to 0x{FormID.FullIdMask:X}.";
        var lift = Lift(limit);
        return $"{noneFree}, up to 0x{limit.Max:X}, the last a {limit.Flag} plugin can address. {char.ToUpperInvariant(lift[0])}{lift[1..]} to draw above it.";
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
