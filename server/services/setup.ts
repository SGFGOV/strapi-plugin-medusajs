import { Strapi } from "@strapi/strapi";
import { default as axios, AxiosResponse } from "axios";
import _ from "lodash";
import * as jwt from "jsonwebtoken";
import { createUserWithAdminRole, hasAuthorRole } from "../bootstrap";
import { MedusaUserParams } from "../types/interfaces";

let strapi: any;

export function config(myStrapi: Strapi): void {
    strapi = myStrapi;
}

export async function hasMedusaRole(): Promise<number | undefined> {
    strapi.log.debug('Checking if "Medusa" role exists');
    try {
        const result = await strapi
            .query("plugin::users-permissions.role")
            .findOne({
                where: { name: "Medusa" }
            }); /** all users created via medusa will be medusas */
        if (result) {
            strapi.log.info("Found role named Medusa");
            return result.id;
        }
        return;
    } catch (e) {
        strapi.log.error("Not Found role named Medusa");
        return;
    }
}

export function enabledCrudOnModels(controllers: any): void {
    Object.keys(controllers).forEach((key) => {
        strapi.log.info(
            `Enabling CRUD permission on model "${key}" for role "Medusa"`
        );
        Object.keys(controllers[key]).forEach((action) => {
            controllers[key][action].enabled = true;
        });
    });
}

export async function createMedusaRole(
    permissions: any
): Promise<number | undefined> {
    try {
        const medusRoleId = await hasMedusaRole();
        if (medusRoleId) {
            return medusRoleId;
        }
    } catch (e) {
        const error = e as Error;
        strapi.log.warn(
            "Unable to determine with medusa role exists: " +
                error.message +
                ":" +
                error.stack
        );
    }

    strapi.log.debug('Creating "Medusa" role');
    const role = {
        name: "Medusa",
        description: "reusing medusa role",
        permissions,
        users: []
    };
    try {
        const roleCreation = await strapi.plugins[
            "users-permissions"
        ].services.role.createRole(role);
        if (roleCreation && roleCreation.length) {
            strapi.log.info('Role - "Medusa" created successfully');
            return roleCreation[0].role.id;
        }
    } catch (e) {
        const error = e as Error;
        strapi.log.warn(
            "Unable to create with medusa role: " +
                error.message +
                ":" +
                error.stack
        );
        return -1;
    }
}

export async function hasMedusaUser(strapi: Strapi): Promise<number | boolean> {
    strapi.log.debug('Checking if "medusa_user" exists');
    const user = await strapi.query("plugin::users-permissions.user").findOne({
        username: "medusa_user"
    });
    if (user && user.id) {
        strapi.log.info('Found user with username "medusa_user"');
        return user.id;
    } else {
        strapi.log.warn('User with username "medusa_user" not found');
        return false;
    }
}

export async function deleteAllEntries(): Promise<void> {
    const plugins = await strapi.plugins["users-permissions"].services[
        "users-permissions"
    ].initialize();

    const permissions = await strapi.plugins["users-permissions"].services[
        "users-permissions"
    ].getActions(plugins);

    //  const controllers = permissions[permission].controllers
    // flush only apis
    const apisToFlush = Object.keys(permissions).filter((value) => {
        return value.startsWith("api::") != false;
    });
    for (const key of apisToFlush) {
        const controllers = permissions[key].controllers;
        for (const controller of Object.keys(controllers)) {
            const queryKey = `${key}.${controller}`;
            const count = await strapi.query(queryKey).count();
            try {
                await strapi.query(queryKey).delete({
                    _limit: count
                });
            } catch (error) {
                strapi.log.info(
                    "unable to flush entity " + queryKey,
                    JSON.stringify(error)
                );
            }
        }
    }
    strapi.log.info("All existing entries deleted");
}

export async function verifyOrCreateMedusaUser(
    medusaUser: MedusaUserParams
): Promise<any> {
    const users = await strapi.plugins[
        "users-permissions"
    ].services.user.fetchAll({
        filters: {
            email: medusaUser.email /** email address is unique */
        }
    });
    if (users.length) {
        return users[0];
    } else {
        return await createMedusaUser(medusaUser);
    }
}

export async function createMedusaUser(
    medusaUser: MedusaUserParams
): Promise<any> {
    let medusaRole;
    strapi.log.info("creating medusa user");
    try {
        medusaRole = await hasMedusaRole();
    } catch (error) {
        strapi.log.error("medusa role doesn't exist", (error as Error).message);
    }

    const params = _.cloneDeep(medusaUser);
    params["role"] = medusaRole;
    try {
        const user = await strapi.plugins[
            "users-permissions"
        ].services.user.add(params);
        if (user && user.id) {
            strapi.log.info(
                `User ${params.username} ${params.email} created successfully with id ${user.id}`
            );

            strapi.log.info(
                `Attaching admin author role to ${params.username} ${params.email}`
            );

            const authorRole = await hasAuthorRole();
            if (authorRole) {
                const adminRolesService = strapi.service("admin::role");
                const authorRole = await adminRolesService.findOne({
                    name: "Author"
                });
                try {
                    const result = await createUserWithAdminRole(
                        params,
                        authorRole
                    );
                    if (result) {
                        strapi.log.info(
                            `Attached admin author role to ${params.username} ${params.email}`
                        );
                    }
                } catch (e) {
                    strapi.log.info(
                        `Unable to attach admin author role to ${params.username} ${params.email}`
                    );
                }
            }

            return user;
        } else {
            strapi.log.error(
                `Failed to create user  ${params.username} ${params.email} `
            );
            return false;
        }
    } catch (error) {
        strapi.log.error((error as Error).message);
        return false;
    }
}

export interface strapiSignal {
    message: string;
    code: number;
    data: any;
}

export async function sendSignalToMedusa(
    message = "Ok",
    code = 200,
    data?: any
): Promise<AxiosResponse | undefined> {
    const medusaServer = `${
        process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
    }`;
    const strapiSignalHook = `${medusaServer}/hooks/strapi-signal`;
    let medusaReady = false;
    const messageData = {
        message,
        code,
        data
    };
    while (!medusaReady) {
        const response = await axios.head(`${medusaServer}/health`);
        medusaReady = response.status < 300 ? true : false;
    }
    try {
        const signedMessage = jwt.sign(
            messageData,
            process.env.MEDUSA_STRAPI_SECRET || "no-secret"
        );
        return await axios.post(strapiSignalHook, {
            signedMessage: signedMessage
        });
    } catch (error) {
        strapi.log.error("unable to send message to medusa server");
    }
}

const lastSyncStarted = false;
let lastSyncCompleted = false;
const lastSyncTime = undefined;

export function createServiceSyncs(data: any): Map<string, any> {
    const serviceApis = new Map<string, any>();
    const fields = Object.keys(data);
    for (const field of fields) {
        const strapiServiceNameParts = [];
        const medusaServiceName = field.substring(0, field.length - 2);
        const upperCaseMatcher = RegExp("[A-Z]");
        const positions = medusaServiceName.matchAll(upperCaseMatcher);
        let nextStartLetter = 0;
        let endLetter = 0;
        for (const post of positions) {
            if (!post.index) {
                endLetter = post.index ?? medusaServiceName.length - 1;
            }
            const word = medusaServiceName.substring(
                nextStartLetter,
                endLetter
            );
            nextStartLetter = endLetter + 1;
            strapiServiceNameParts.push(word);
        }
        const lastWord = medusaServiceName.substring(
            nextStartLetter,
            medusaServiceName.length - 1
        );
        strapiServiceNameParts.push(lastWord);
        const strapiServiceName = strapiServiceNameParts.join("-");

        const serviceApi = `api::${strapiServiceName}.${strapiServiceName}`;
        serviceApis.set(serviceApi, field);
    }
    return serviceApis;
}

export async function synchroniseWithMedusa(): Promise<boolean | undefined> {
    const currentSyncTime = Date.now();
    const syncInterval = 300e3; /** to be made configurable */

    const medusaServer = `${
        process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
    }`;
    const medusaSeedHookUrl = `${medusaServer}/hooks/seed`;
    try {
        // return;

        let medusaReady = false;
        while (!medusaReady) {
            const response = await axios.head(`${medusaServer}/health`);
            medusaReady = response.status < 300 ? true : false;
        }
    } catch (e) {
        // console.log(e);

        strapi.log.info(
            "Unable to connect to Medusa server. Please make sure Medusa server is up and running",
            JSON.stringify(e)
        );
        return false;
        // process.exit(1)
    }
    if (lastSyncStarted && !lastSyncCompleted) {
        strapi.log.warn("already a sync is in progress");
        return true;
    }
    if (currentSyncTime - (lastSyncTime ?? 0) < syncInterval) {
        strapi.log.warn("sync received too soon");
        return true;
    }
    let seedData: AxiosResponse;
    try {
        strapi.log.info(
            "attempting to sync connect with medusa server on ",
            medusaSeedHookUrl
        );
        seedData = await axios.post(medusaSeedHookUrl, {}, {});
    } catch (e) {
        // console.log(e);

        strapi.log.info(
            "Unable to Sync with to Medusa server. Check data recieved",
            JSON.stringify(e)
        );
        return false;
    }
    // IMPORTANT: Order of seed must be maintained. Please don't change the order

    try {
        /*     const products = seedData?.data?.products;
    const regions = seedData?.data?.regions;
    const shippingOptions = seedData?.data?.shippingOptions;
    const paymentProviders = seedData?.data?.paymentProviders;
    const fulfillmentProviders = seedData?.data?.fulfillmentProviders;
    const shippingProfiles = seedData?.data?.shippingProfiles;
    const stores = seedData?.data?.stores;
        const servicesToSync = {
            "api::fulfillment-provider.fulfillment-provider":
                fulfillmentProviders,
            "api::payment-provider.payment-provider": paymentProviders,
            "api::region.region": regions,
            "api::shipping-option.shipping-option": shippingOptions,
            "api::shipping-profile.shipping-profile": shippingProfiles,
            "api::product.product": products,
            "api::store.store": stores
        };*/
        const servicesToSync = createServiceSyncs(seedData.data);

        servicesToSync.forEach(async (serviceData, serviceKey) => {
            await strapi.services[serviceKey].bootstrap(serviceData);
        });
        strapi.log.info("SYNC FINISHED");
        lastSyncCompleted = true;
        const result =
            (await sendSignalToMedusa("SYNC COMPLETED"))?.status == 200;
        return result;
    } catch (e) {
        // console.log(e);

        strapi.log.info(
            "Unable to Sync with to Medusa server. Please check data recieved",
            JSON.stringify(e)
        );
        return false;
        // process.exit(1)
    }
}

const setup = {
    createMedusaUser,
    synchroniseWithMedusa,
    deleteAllEntries,
    hasMedusaRole,
    hasMedusaUser
};

export default setup;
