const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors")({ origin: true });
const app = express();

app.use(cors);

var serviceAccount = require("./permissions.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://friendcrm-4014e.firebaseio.com",
});

const db = admin.firestore();
const usersCollection = db.collection("users");
const batchesCollection = db.collection("batches");
const entriesCollection = db.collection("entries");

function checkAPIKey(apikey) {
  return apikey === "Bearer " + serviceAccount.private_key_id;
}

// create
app.post("/api/create", async (req, res) => {
  try {
    if (!req.body.name || !req.body.interaction) {
      return res.status(400).send("Missing fields");
    }

    if (checkAPIKey(req.headers.authorization)) {
      let doesUserExist = false;
      let batch = db.batch();
      const loggedDate = admin.firestore.Timestamp.fromDate(new Date());
      let userID = "";

      // check if user already exists
      await usersCollection
        .where("name", "==", req.body.name)
        .limit(1)
        .get()
        .then((snapshot) => {
          if (!snapshot.empty) {
            snapshot.forEach((doc) => {
              // doc.data() is never undefined for query doc snapshots

              doesUserExist = true;
              console.log("user exists");

              const userContents = doc.data();
              let interactions = userContents.interactions;
              let count = userContents.count;
              let countTotal = userContents.countTotal + 1;

              interactions.push({
                interaction: req.body.interaction,
                loggedDate: loggedDate,
              });

              if (count[req.body.interaction]) {
                count[req.body.interaction] += 1;
              } else {
                count[req.body.interaction] = 1;
              } // add interaction count

              userID = doc.id;

              const targetUser = usersCollection.doc(userID);

              // targetUser.update({
              //   count: count,
              //   interactions: interactions,
              //   lastInteraction: loggedDate,
              // });

              batch.update(targetUser, {
                count: count,
                interactions: interactions,
                lastInteraction: loggedDate,
                countTotal: countTotal,
              });
            });
          } // if user exists
          return null;
        }); // then

      //user doesn't exist, add new
      if (doesUserExist === false) {
        console.log("user doesnt exists. making new");
        let contents = {
          name: req.body.name,
          count: 1,
          interactions: [
            {
              interaction: req.body.interaction,
              loggedDate: loggedDate,
            },
          ],
        };

        const newUser = usersCollection.doc();
        userID = newUser.id;
        batch.set(newUser, contents);
        //   await usersCollection.add(contents);
      } // if new user

      //check if qualifies for batch
      let isPartOfBatch = false;
      await batchesCollection
        .orderBy("loggedDate", "desc")
        .limit(1)
        .get()
        .then((querySnapshot) => {
          let docs = querySnapshot.docs;

          for (let doc of docs) {
            const contents = doc.data();

            const timeDiff = Math.abs(
              loggedDate.seconds - contents.loggedDate.seconds
            );

            if (timeDiff < 240 && !contents.locked) {
              console.log("adding to batch");
              const users = contents.users;
              users[userID] = { name: req.body.name };

              let count = 1;

              if (!isNaN(contents.count)) {
                count = contents.count + 1;
              }

              console.log({
                loggedDate: loggedDate,
                users: users,
              });

              thisBatch = batchesCollection.doc(doc.id);

              batch.update(thisBatch, {
                count: count,
                loggedDate: loggedDate,
                users: users,
              });

              isPartOfBatch = true;
            }
          }

          return null;
        }); // check batch to insert

      // doesn't qualify for batch, check if recent entry is close enough to make new batch
      if (isPartOfBatch === false) {
        await entriesCollection
          .orderBy("loggedDate", "desc")
          .limit(1)
          .get()
          .then((querySnapshot) => {
            let docs = querySnapshot.docs;

            for (let doc of docs) {
              const contents = doc.data();

              const timeDiff = Math.abs(
                loggedDate.seconds - contents.loggedDate.seconds
              );

              if (timeDiff < 240) {
                // add to batch
                // update time stampe
                // add user

                console.log(
                  "not part of last batch. checking last entry to maybe batch"
                );

                const newBatch = batchesCollection.doc();

                const newBatchContents = {
                  loggedDate: loggedDate,
                  count: 0,
                  users: {},
                };

                newBatchContents["users"][userID] = {
                  name: req.body.name,
                };

                newBatchContents["users"][Object.keys(contents.users)[0]] = {
                  name: Object.entries(contents.users)[0][1]["name"],
                };

                batch.set(newBatch, newBatchContents);
              }
            }

            return null;
          }); // check entry
      } //isPartOfBatch == false

      // make new raw entry
      console.log("add to entry");
      const newEntry = entriesCollection.doc();
      let newEntryContents = {
        interaction: req.body.interaction,
        loggedDate: loggedDate,
        users: {},
      };
      newEntryContents["users"][userID] = { name: req.body.name };

      batch.set(newEntry, newEntryContents);

      console.log("committing batch");

      await batch
        .commit()
        .then((res) => console.log("obj updated", res))
        .catch((err) => console.log("Error obj updated", err));

      return res.status(200).send(userID);
    } else {
      return res.status(401).send("Not Authorized");
    }
  } catch (error) {
    console.log(error);
    return res.status(500).send(error);
  }
}); // create

// read batches
app.post("/api/createBatch", (req, res) => {
  (async () => {
    try {
      if (!req.body.batchID || !req.body.interaction) {
        return res.status(400).send("Missing fields");
      }

      if (checkAPIKey(req.headers.authorization)) {
        let batch = db.batch();
        const loggedDate = admin.firestore.Timestamp.fromDate(new Date());

        console.log(req.body.batchID);
        const batchID = req.body.batchID;
        let batchContents = {};

        await batchesCollection
          .doc(batchID)
          .get()
          .then((doc) => {
            if (doc.exists) {
              // add entry
              // update user
              batchContents = doc.data();
            } else {
              // doc.data() will be undefined in this case
              console.log("No such document!");
            }
            return;
          })
          .catch((error) => {
            console.log("Error getting document:", error);
          });

        let users = {};

        await usersCollection
          .get()
          .then((querySnapshot) => {
            querySnapshot.forEach((doc) => {
              users[doc.id] = doc.data();
              users[doc.id]["userID"] = doc.id;
            });
            return null;
          })
          .catch((error) => {
            console.log("Error getting document:", error);
          });

        for (const userID in batchContents.users) {
          const newEntry = entriesCollection.doc();
          let newEntryContents = {
            interaction: req.body.interaction,
            loggedDate: loggedDate,
            users: {},
          };
          newEntryContents["users"][userID] = {
            name: batchContents.users[userID]["name"],
          };

          console.log(newEntryContents);

          batch.set(newEntry, newEntryContents);

          let userContents = users[userID];
          let interactions = userContents.interactions;
          let count = userContents.count;
          let countTotal = userContents.countTotal + 1;

          interactions.push({
            interaction: req.body.interaction,
            loggedDate: loggedDate,
          });

          if (count[req.body.interaction]) {
            count[req.body.interaction] += 1;
          } else {
            count[req.body.interaction] = 1;
          } // add interaction count

          const targetUser = usersCollection.doc(userID);

          batch.update(targetUser, {
            count: count,
            interactions: interactions,
            lastInteraction: loggedDate,
            countTotal: countTotal,
          });
        }

        const targetBatch = batchesCollection.doc(batchID);

        let count = 1;

        if (!isNaN(batchContents.count)) {
          count = batchContents.count + 1;
        }

        batch.update(targetBatch, { count: count, loggedDate: loggedDate });

        await batch
          .commit()
          .then((res) => console.log("obj updated", res))
          .catch((err) => console.log("Error obj updated", err));

        return res.status(200).send("Saved");
      } else {
        return res.status(401).send("Not Authorized");
      }
    } catch (error) {
      console.log(error);
      return res.status(500).send(error);
    }
  })();
});

// read item
// app.get("/api/read/:item_id", (req, res) => {
//   (async () => {
//     try {
//       if (checkAPIKey(req.headers.authorization)) {
//         const document = usersCollection.doc(req.params.item_id);
//         let doc = await document.limit(1).get();
//         let response = {};

//         response[req.params.item_id] = doc.data();

//         return res.status(200).send(response);
//       } else {
//         return res.status(401).send("Not Authorized");
//       }
//     } catch (error) {
//       console.log(error);
//       return res.status(500).send(error);
//     }
//   })();
// });

// read all
app.get("/api/read", (req, res) => {
  (async () => {
    try {
      if (checkAPIKey(req.headers.authorization)) {
        let response = {};

        const limit = req.query.limit ? parseFloat(req.query.limit) : 20;
        const sortBy = req.query.sortBy ? req.query.sortBy : "lastInteraction";

        await usersCollection
          .orderBy(sortBy, "desc")
          .limit(limit)
          .get()
          .then((querySnapshot) => {
            let docs = querySnapshot.docs;

            for (let doc of docs) {
              response[doc.id] = doc.data();
            }

            return null;
          });
        return res.status(200).send(response);
      } else {
        return res.status(401).send("Not Authorized");
      }
    } catch (error) {
      console.log(error);
      return res.status(500).send(error);
    }
  })();
});

// read batches
app.get("/api/batches", (req, res) => {
  (async () => {
    try {
      if (checkAPIKey(req.headers.authorization)) {
        let response = {};

        const limit = req.query.limit ? parseFloat(req.query.limit) : 10;

        console.log(limit, req.query.limit);

        await batchesCollection
          .orderBy("loggedDate", "desc")
          .limit(limit)
          .get()
          .then((querySnapshot) => {
            let docs = querySnapshot.docs;

            for (let doc of docs) {
              const content = doc.data();

              response[doc.id] = content;
              response[doc.id]["batchID"] = doc.id;

              let compiledLabel = "";
              for (let name in content["users"]) {
                const spaceIndex = content["users"][name]["name"].indexOf(" ");
                compiledLabel +=
                  content["users"][name]["name"].slice(0, spaceIndex + 2) +
                  "., ";
              }

              response[doc.id]["compiledLabel"] = compiledLabel.slice(0, -2);
            }

            return null;
          });
        return res.status(200).send(response);
      } else {
        return res.status(401).send("Not Authorized");
      }
    } catch (error) {
      console.log(error);
      return res.status(500).send(error);
    }
  })();
});

// read entries
app.get("/api/entries", (req, res) => {
  (async () => {
    try {
      if (checkAPIKey(req.headers.authorization)) {
        let response = {};

        console.log(req.query);
        const limit = req.query.limit ? parseFloat(req.query.limit) : 99999;

        console.log(limit, req.query.limit);

        await entriesCollection
          .orderBy("loggedDate", "desc")
          .limit(limit)
          .get()
          .then((querySnapshot) => {
            let docs = querySnapshot.docs;

            for (let doc of docs) {
              const content = doc.data();

              response[doc.id] = content;
              response[doc.id]["entryID"] = doc.id;
            }

            return null;
          });
        return res.status(200).send(response);
      } else {
        return res.status(401).send("Not Authorized");
      }
    } catch (error) {
      console.log(error);
      return res.status(500).send(error);
    }
  })();
});

// update
// app.put("/api/update/:item_id", (req, res) => {
//   (async () => {
//     try {
//       if (checkAPIKey(req.headers.authorization)) {
//         const document = usersCollection.doc(req.params.item_id);
//         await document.update(req.body);
//         return res.status(200).send();
//       } else {
//         return res.status(401).send("Not Authorized");
//       }
//     } catch (error) {
//       console.log(error);
//       return res.status(500).send(error);
//     }
//   })();
// });

// delete
// app.delete("/api/delete/:item_id", (req, res) => {
//   (async () => {
//     try {
//       if (checkAPIKey(req.headers.authorization)) {
//         const document = usersCollection.doc(req.params.item_id);
//         await document.delete();
//         return res.status(200).send();
//       } else {
//         return res.status(401).send("Not Authorized");
//       }
//     } catch (error) {
//       console.log(error);
//       return res.status(500).send(error);
//     }
//   })();
// });

exports.app = functions.https.onRequest(app);
